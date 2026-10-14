/**
 * Talking to Plaid (BANK-06): one call, with the keys in the body as Plaid asks. What an
 * answer means is `packages/core/src/plaid.ts`.
 *
 * A failure is described by status and Plaid's error codes, never its message (invariant 4).
 */
import {
  errorCode,
  mergeSync,
  parseSyncPage,
  plaidCode,
  signInAgain,
} from '../../packages/core/src/plaid.ts';
import type { ItemAnswers, SyncPage, Synced } from '../../packages/core/src/plaid.ts';

export type PlaidKeys = {
  readonly clientId: string;
  readonly secret: string;
  readonly env: 'sandbox' | 'production';
};

export function plaidEnv(name: string): PlaidKeys['env'] | null {
  return name === 'sandbox' || name === 'production' ? name : null;
}

/**
 * Plaid's keys as it issued them on 25 Sep 2026: a client id of 24 hex characters and a
 * secret of 30. The first keys kept here each carried a trailing `\` from the paste, which
 * Plaid answered only as *client_id must be a properly formatted, non-empty string*.
 */
export function wellFormed(clientId: string, secret: string): boolean {
  return /^[0-9a-f]{24}$/.test(clientId) && /^[0-9a-f]{30}$/.test(secret);
}

export function baseUrl(env: PlaidKeys['env']): string {
  return `https://${env}.plaid.com`;
}

export type Called =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: string; readonly code: string | null };

export async function call(
  keys: PlaidKeys,
  path: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<Called> {
  let response: Response;
  try {
    response = await fetcher(`${baseUrl(keys.env)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: keys.clientId, secret: keys.secret, ...body }),
      signal: AbortSignal.timeout(50_000),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    return { ok: false, reason: `Plaid did not answer ${path} (${name})`, code: null };
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    return {
      ok: false,
      reason: `Plaid answered ${path} with HTTP ${response.status}, not JSON`,
      code: null,
    };
  }
  if (!response.ok) {
    const code = errorCode(answer) ?? 'no error code';
    return {
      ok: false,
      reason: `Plaid refused ${path}: HTTP ${response.status}, ${code}`,
      code: plaidCode(answer),
    };
  }
  return { ok: true, body: answer };
}

export type PulledItems =
  | {
      readonly ok: true;
      readonly items: ItemAnswers[];
      /** A bank left out because it wants signing in again, in `signInAgain`'s words. */
      readonly warnings: string[];
      readonly requests: number;
    }
  | { readonly ok: false; readonly reason: string; readonly requests: number };

/**
 * Each item's `/item/get` and `/accounts/get`, every item at once. `/accounts/get` is the
 * balance Plaid last fetched, not a fresh one: a fresh one is `/accounts/balance/get`, the
 * Balance product, which is billed per call once off the Trial plan.
 *
 * An item that wants signing in again is left out and named in `warnings`, and the rest are
 * read (BANK-10). Until 26 Sep it failed the night, so Harbor wanting a sign-in stopped
 * Lakeside Bank updating too; SimpleFIN already kept the rest and warned (BANK-09). Leaving
 * it out is safe because `bank_store` touches only the accounts it is given: Harbor's keep
 * their last balance and reading. When every item wants signing in there is nothing to
 * read, and that is still a failure, so the home screen never says Plaid was read just now
 * about no accounts at all. Any other refusal fails the night, naming the item by its place.
 */
export async function pullItems(
  keys: PlaidKeys,
  tokens: readonly string[],
  fetcher: typeof fetch,
): Promise<PulledItems> {
  const answers = await Promise.all(
    tokens.map((access_token) =>
      Promise.all([
        call(keys, '/item/get', { access_token }, fetcher),
        call(keys, '/accounts/get', { access_token }, fetcher),
      ]),
    ),
  );
  const requests = answers.length * 2;
  const items: ItemAnswers[] = [];
  const warnings: string[] = [];
  for (const [n, [item, accounts]] of answers.entries()) {
    if (!item.ok) return { ok: false, reason: `item ${n + 1}: ${item.reason}`, requests };
    if (!accounts.ok && accounts.code === 'ITEM_LOGIN_REQUIRED') {
      warnings.push(signInAgain(item.body, n));
      continue;
    }
    if (!accounts.ok) return { ok: false, reason: `item ${n + 1}: ${accounts.reason}`, requests };
    items.push({ place: n, item: item.body, accounts: accounts.body });
  }
  if (items.length === 0 && warnings.length > 0) {
    return { ok: false, reason: warnings.join('; '), requests };
  }
  return { ok: true, items, warnings, requests };
}

/** 500 is the most one page may hold. */
const SYNC_PAGE = 500;

/**
 * Pages one night reads before it stores what it has. The cursor saved is the last page's,
 * so the next night carries on where this one stopped rather than losing the rest. 20 pages
 * are 10,000 transactions, far more than a card makes in the 90 days a first sync returns.
 */
const SYNC_PAGES = 20;

/** Tries at a consistent set of pages before the night gives up on the item. */
const SYNC_TRIES = 3;

export type SyncedItem =
  | { readonly ok: true; readonly synced: Synced; readonly requests: number }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly code: string | null;
      readonly requests: number;
    };

/**
 * One item's changes since `cursor` (`''` for everything Plaid holds), page by page. Plaid
 * refuses a page when the item changed underneath the pages already read
 * (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`), and its answer is to start again from
 * the cursor the night began with.
 */
export async function syncItem(
  keys: PlaidKeys,
  token: string,
  item: string,
  cursor: string,
  fetcher: typeof fetch,
): Promise<SyncedItem> {
  let requests = 0;
  for (let attempt = 0; attempt < SYNC_TRIES; attempt += 1) {
    const pages: SyncPage[] = [];
    let next = cursor;
    let changed = false;
    for (let n = 0; n < SYNC_PAGES; n += 1) {
      const body = {
        access_token: token,
        count: SYNC_PAGE,
        ...(next === '' ? {} : { cursor: next }),
      };
      const answer = await call(keys, '/transactions/sync', body, fetcher);
      requests += 1;
      if (!answer.ok && answer.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        changed = true;
        break;
      }
      if (!answer.ok) return { ok: false, reason: answer.reason, code: answer.code, requests };
      const page = parseSyncPage(answer.body);
      if (!page.ok) {
        const reason = `Plaid's /transactions/sync answer did not parse (${page.issues.length} issue(s))`;
        return { ok: false, reason, code: null, requests };
      }
      pages.push(page.value);
      next = page.value.next_cursor;
      if (!page.value.has_more) break;
    }
    if (!changed) return { ok: true, synced: mergeSync(item, pages), requests };
  }
  return {
    ok: false,
    reason: 'Plaid kept changing the transactions while they were read',
    code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    requests,
  };
}
