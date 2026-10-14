/**
 * The nightly pull (BANK-02): read the last 90 days from the Bridge, store them through
 * `public.bank_store`, and leave a `bank_pulls` row saying what happened.
 *
 * Every run reads all 90 days the Bridge has rather than "since the last success", so a
 * night Vercel skips costs nothing and a night it delivers twice changes nothing: the
 * store upserts on the Bridge's ids. What is older than 90 days exists only in Dinora, which
 * is why this has to run at all — BofA's history is 90 days (BANK-01).
 *
 * Scheduled twice, at 09:00 and 11:00 UTC (vercel.json). A day after the last pull the
 * Bridge's copy is stale, and it asks the bank while the request waits; on 24 Sep 2026 that
 * outlasted a 25 s timeout, and the same run minutes later took 4.7 s. So the first run may
 * only set the refresh going, and the second reads what it fetched. Two hours apart because
 * Hobby fires anywhere inside the named hour. When both succeed the second changes nothing.
 *
 * Talks to Supabase with plain fetch against PostgREST and the auth admin API rather than a
 * client library: three requests do not justify a dependency Vercel has to trace, and plain
 * requests are what the tests can stand in for.
 */
import { z } from 'zod';

import { parse } from '../../packages/core/src/parse.ts';
import {
  NIGHTLY_WINDOWS,
  detail,
  dropsFrom,
  historyFrom,
  windows,
} from '../../packages/core/src/simplefin.ts';
import type { Rows } from '../../packages/core/src/simplefin.ts';
import {
  bankName,
  plaidRows,
  signInAgain,
  transactionsItem,
} from '../../packages/core/src/plaid.ts';
import type { ItemAnswers, Synced } from '../../packages/core/src/plaid.ts';
import { plaidEnv, pullItems, syncItem, wellFormed } from './plaid.ts';
import type { PlaidKeys } from './plaid.ts';
import { BRIDGE_TIMEOUT_MS, FIRST_ASK_MS, access, pull } from './simplefin.ts';

export type NightlyEnv = {
  readonly SIMPLEFIN_ACCESS_URL?: string | undefined;
  readonly SUPABASE_URL?: string | undefined;
  readonly SUPABASE_SECRET_KEY?: string | undefined;
};

/**
 * Plaid's keys and one access token per linked item, space-separated (BANK-07). Set in
 * Vercel's environment by Nora, never through a session, like `SIMPLEFIN_ACCESS_URL`.
 * `PLAID_ENV` defaults to production, the only one with her accounts in it.
 */
export type PlaidNightlyEnv = NightlyEnv & {
  readonly PLAID_CLIENT_ID?: string | undefined;
  readonly PLAID_SECRET?: string | undefined;
  readonly PLAID_ENV?: string | undefined;
  readonly PLAID_ACCESS_TOKENS?: string | undefined;
};

type Source = 'simplefin' | 'plaid';

/** What the run answers the cron with. Counts only: Vercel logs it (invariant 4). */
export type NightlyOutcome =
  | {
      readonly ok: true;
      readonly requests: number;
      readonly accounts: number;
      readonly transactions: number;
      readonly added: number;
      readonly dropped: number;
      readonly restored: number;
      /** Readings kept or replaced, and rebuilt days written (ACCT-03). */
      readonly kept: number;
      readonly rebuilt: number;
      readonly markedDrops: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly recorded: boolean };

// `guid`, not `uuid`: Zod 4's uuid checks the version bits, which Postgres does not, and the
// local seed's users are `1111…` and `2222…`.
const usersSchema = z.object({ users: z.array(z.object({ id: z.guid() })) });

const storedSchema = z.object({
  requests: z.number(),
  accounts: z.number(),
  transactions: z.number(),
  added: z.number(),
  dropped: z.number(),
  restored: z.number(),
  kept: z.number(),
  rebuilt: z.number(),
  drops_from: z.string().nullable(),
});

export type Supabase = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch;
};

/**
 * The one person whose banks these are. Signup is closed and she was made by hand
 * (invariant 8), so there is exactly one user; if there are ever two, which of them the
 * credential belongs to is a question this job must not answer by guessing.
 */
export async function owner(db: Supabase): Promise<{ id: string } | { reason: string }> {
  const response = await db.fetch(`${db.url}/auth/v1/admin/users?page=1&per_page=2`, {
    headers: db.headers,
  });
  if (!response.ok) return { reason: `listing users answered HTTP ${response.status}` };
  const parsed = parse(usersSchema, await response.json());
  if (!parsed.ok) return { reason: 'listing users answered in an unexpected shape' };
  const [only, ...others] = parsed.value.users;
  if (only === undefined || others.length > 0) {
    return { reason: `expected exactly one user, found ${others.length > 0 ? 'more' : 'none'}` };
  }
  return { id: only.id };
}

async function recordFailure(
  db: Supabase,
  user: string,
  source: Source,
  startedAt: string,
  requests: number,
  reason: string,
): Promise<boolean> {
  const response = await db.fetch(`${db.url}/rest/v1/bank_pulls`, {
    method: 'POST',
    headers: { ...db.headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user,
      source,
      outcome: 'failed',
      started_at: startedAt,
      requests,
      detail: reason,
    }),
  });
  return response.ok;
}

type Connected = {
  readonly db: Supabase;
  readonly user: string;
  readonly startedAt: string;
  readonly fail: (reason: string, requests: number) => Promise<NightlyOutcome>;
};

/** The database and its one user, or why not. Shared by both sources' runs. */
async function connect(
  env: NightlyEnv,
  source: Source,
  fetchFn: typeof fetch,
  now: Date,
): Promise<Connected | NightlyOutcome> {
  const url = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SECRET_KEY ?? '';
  const db: Supabase = {
    url,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    fetch: fetchFn,
  };
  const startedAt = now.toISOString();
  const who = await owner(db);
  if ('reason' in who) return { ok: false, reason: who.reason, recorded: false };
  return {
    db,
    user: who.id,
    startedAt,
    fail: async (reason, requests) => ({
      ok: false,
      reason,
      recorded: await recordFailure(db, who.id, source, startedAt, requests, reason),
    }),
  };
}

type Run = {
  readonly requests: number;
  readonly dropsFrom: string | null;
  readonly historyFrom: string | null;
  /** Plaid's own: the transactions it says are gone, and where each item's sync got to. */
  readonly removed?: readonly string[];
  readonly cursors?: readonly { readonly item: string; readonly cursor: string }[];
};

async function store(c: Connected, source: Source, rows: Rows, run: Run): Promise<NightlyOutcome> {
  const response = await c.db.fetch(`${c.db.url}/rest/v1/rpc/bank_store`, {
    method: 'POST',
    headers: { ...c.db.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_user: c.user,
      p_source: source,
      // `history_from` rides in the payload rather than as a parameter, so a bundle older
      // than the migration still calls the function it has (invariant 7).
      p_payload: {
        accounts: rows.accounts,
        transactions: rows.transactions,
        history_from: run.historyFrom,
        removed: run.removed ?? [],
        cursors: run.cursors ?? [],
      },
      p_started_at: c.startedAt,
      p_requests: run.requests,
      p_drops_from: run.dropsFrom,
      p_detail: detail(rows),
    }),
  });
  if (!response.ok) return c.fail(`storing answered HTTP ${response.status}`, run.requests);
  const stored = parse(storedSchema, await response.json());
  // A 2xx from the store means its `ok` row committed with the rows, so recording a failure
  // now would contradict it. Only this answer is in doubt.
  if (!stored.ok) {
    return {
      ok: false,
      reason: 'stored, but the answer was not the expected shape',
      recorded: true,
    };
  }

  const s = stored.value;
  return {
    ok: true,
    requests: s.requests,
    accounts: s.accounts,
    transactions: s.transactions,
    added: s.added,
    dropped: s.dropped,
    restored: s.restored,
    kept: s.kept,
    rebuilt: s.rebuilt,
    markedDrops: s.drops_from !== null,
  };
}

function missing<K extends string>(
  env: Partial<Record<K, string | undefined>>,
  keys: readonly K[],
): NightlyOutcome | null {
  const absent = keys.filter((k) => (env[k] ?? '').trim() === '');
  return absent.length === 0
    ? null
    : { ok: false, reason: `not configured: ${absent.join(', ')}`, recorded: false };
}

export async function nightly(
  env: NightlyEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<NightlyOutcome> {
  const unset = missing(env, ['SIMPLEFIN_ACCESS_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']);
  if (unset !== null) return unset;
  const c = await connect(env, 'simplefin', fetchFn, now);
  if ('ok' in c) return c;

  const credential = access(env.SIMPLEFIN_ACCESS_URL ?? '');
  if (credential === null) {
    return c.fail('SIMPLEFIN_ACCESS_URL is not an https access URL with credentials in it', 0);
  }

  const seconds = Math.floor(now.getTime() / 1000);
  const pulled = await pull(credential, windows(seconds, NIGHTLY_WINDOWS), {
    fetch: fetchFn,
    order: 'inTurn',
    timeoutMs: FIRST_ASK_MS,
    budgetMs: BRIDGE_TIMEOUT_MS,
  });
  if (!pulled.ok) return c.fail(pulled.reason, pulled.requests);

  return store(c, 'simplefin', pulled.rows, {
    requests: pulled.requests,
    dropsFrom: dropsFrom(pulled.rows, pulled.covered, seconds),
    historyFrom: historyFrom(pulled.rows, pulled.covered, seconds),
  });
}

const cursorsSchema = z.array(z.object({ item: z.string(), cursor: z.string() }));

/** Where each Plaid item's sync got to, by Plaid's item id, or null when the store did not answer. */
async function cursors(c: Connected): Promise<Map<string, string> | null> {
  const query = `user_id=eq.${c.user}&source=eq.plaid&deleted_at=is.null&select=item,cursor`;
  const response = await c.db.fetch(`${c.db.url}/rest/v1/bank_cursors?${query}`, {
    headers: c.db.headers,
  });
  if (!response.ok) return null;
  const parsed = parse(cursorsSchema, await response.json());
  return parsed.ok ? new Map(parsed.value.map((r) => [r.item, r.cursor])) : null;
}

type Syncs = {
  readonly synced: Map<number, Synced>;
  readonly warnings: string[];
  readonly requests: number;
};

/**
 * Each item that reads transactions, synced from where it last got to (BANK-14). An item
 * whose sync fails keeps its balances and is named in the warnings, because a card's
 * balance tonight is worth more than its charges waiting a night; its cursor stays where it
 * was, so tomorrow asks for the same changes again.
 */
async function syncAll(
  keys: PlaidKeys,
  tokens: readonly string[],
  items: readonly ItemAnswers[],
  held: ReadonlyMap<string, string>,
  fetchFn: typeof fetch,
): Promise<Syncs> {
  const synced = new Map<number, Synced>();
  const warnings: string[] = [];
  let requests = 0;
  const answers = await Promise.all(
    items.map(async (answers) => {
      const id = transactionsItem(answers.item);
      const token = tokens[answers.place];
      if (id === null || token === undefined) return null;
      return { answers, got: await syncItem(keys, token, id, held.get(id) ?? '', fetchFn) };
    }),
  );
  for (const answer of answers) {
    if (answer === null) continue;
    const { answers: item, got } = answer;
    requests += got.requests;
    if (got.ok) synced.set(item.place, got.synced);
    else if (got.code === 'ITEM_LOGIN_REQUIRED') warnings.push(signInAgain(item.item, item.place));
    else
      warnings.push(
        `${bankName(item.item, item.place)}'s transactions were not read: ${got.reason}`,
      );
  }
  return { synced, warnings, requests };
}

/**
 * The Plaid night (BANK-07): each item's institution and accounts, and the new transactions
 * of each item that reads them (BANK-14), stored through the same `bank_store` as source
 * `plaid`. Plaid names what it removed, so nothing is marked dropped by absence, and no
 * `history_from`: a sync answers with what changed, not with a window it covered whole. Runs
 * beside the SimpleFIN night and fails on its own, so one aggregator down never costs the
 * other its night.
 */
export async function plaidNightly(
  env: PlaidNightlyEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<NightlyOutcome> {
  const unset = missing(env, [
    'PLAID_CLIENT_ID',
    'PLAID_SECRET',
    'PLAID_ACCESS_TOKENS',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
  ]);
  if (unset !== null) return unset;
  const c = await connect(env, 'plaid', fetchFn, now);
  if ('ok' in c) return c;

  const clientId = env.PLAID_CLIENT_ID ?? '';
  const secret = env.PLAID_SECRET ?? '';
  const plaid = plaidEnv(env.PLAID_ENV ?? 'production');
  if (plaid === null || !wellFormed(clientId, secret)) {
    return c.fail("PLAID_CLIENT_ID, PLAID_SECRET or PLAID_ENV is not Plaid's form", 0);
  }
  const tokens = (env.PLAID_ACCESS_TOKENS ?? '').split(/\s+/).filter((t) => t !== '');

  const keys: PlaidKeys = { clientId, secret, env: plaid };
  const pulled = await pullItems(keys, tokens, fetchFn);
  if (!pulled.ok) return c.fail(pulled.reason, pulled.requests);
  const syncing = pulled.items.some((i) => transactionsItem(i.item) !== null);
  const held = syncing ? await cursors(c) : new Map<string, string>();
  if (held === null) return c.fail('reading where each sync got to failed', pulled.requests);
  const syncs = await syncAll(keys, tokens, pulled.items, held, fetchFn);
  const requests = pulled.requests + syncs.requests;
  const warnings = [...pulled.warnings, ...syncs.warnings];
  const read = plaidRows(pulled.items, c.startedAt, warnings, syncs.synced);
  if (!read.ok) return c.fail(read.reason, requests);

  return store(c, 'plaid', read.rows, {
    requests,
    dropsFrom: null,
    historyFrom: null,
    removed: read.removed,
    cursors: read.cursors,
  });
}
