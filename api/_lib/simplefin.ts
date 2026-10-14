/**
 * Talking to the SimpleFIN Bridge: the access URL, the request for one window, and a pull of
 * several. Shared by the nightly cron and `pnpm bank:pull`, so the two read the Bridge the
 * same way; what its answer means is `packages/core/src/simplefin.ts`.
 *
 * Nothing here prints or returns an amount or a payee (invariant 4). A failure is described
 * by status and count, because a description is what lands in a log and on screen.
 */
import { Buffer } from 'node:buffer';

import { combine, parseAccountSet, toRows } from '../../packages/core/src/simplefin.ts';
import type { Rows, Window } from '../../packages/core/src/simplefin.ts';

export type Access = { readonly base: string; readonly authorization: string };

/**
 * The access URL carries its credential as `https://user:pass@host/simplefin`. Node's fetch
 * refuses a URL with credentials in it, so they move into a Basic header, and `base` is what
 * is left — safe to print, which the URL itself never is.
 */
export function access(accessUrl: string): Access | null {
  let url: URL;
  try {
    url = new URL(accessUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username === '' || url.password === '') return null;
  const credential = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  const authorization = `Basic ${Buffer.from(credential).toString('base64')}`;
  url.username = '';
  url.password = '';
  return { base: url.toString().replace(/\/+$/, ''), authorization };
}

/** The demo the Bridge publishes for anyone to read (protocol page, fetched 24 Sep 2026). */
export const DEMO_ACCESS_URL = 'https://demo:demo@beta-bridge.simplefin.org/simplefin';

export function accountsUrl(base: string, window: Window): string {
  const query = new URLSearchParams({
    version: '2',
    pending: '1',
    'start-date': String(window.start),
    'end-date': String(window.end),
  });
  return `${base}/accounts?${query.toString()}`;
}

export type Pulled =
  | {
      readonly ok: true;
      readonly rows: Rows;
      /** The windows actually asked for, which is fewer than wanted when one came back empty. */
      readonly covered: readonly Window[];
      readonly requests: number;
    }
  | { readonly ok: false; readonly reason: string; readonly requests: number };

/**
 * `together` asks every window at once. `inTurn` asks each only once the one before has
 * answered. `untilEmpty` asks in turn and stops at the first empty window after the newest,
 * where the bank has run out of history.
 */
export type Order = 'together' | 'inTurn' | 'untilEmpty';

export type PullOptions = {
  readonly fetch: typeof fetch;
  readonly order: Order;
  readonly onWindow?: (window: Window, transactions: number) => void;
  /** Per request. */
  readonly timeoutMs?: number;
  /** For the whole pull: a request never waits past it, and none is sent once it is spent. */
  readonly budgetMs?: number;
  readonly clock?: () => number;
};

/**
 * Long, because the Bridge asks the bank while it waits when what it holds is stale — which
 * a day after the last pull it is. Measured 24 Sep 2026: the first production run's first
 * request got no answer in 25 s; the same request from a laptop minutes later took 1.7 s,
 * and a rerun on Vercel stored everything in 4.7 s. The refresh, not the network. 50 s
 * leaves room inside the function's 60 (vercel.json) for the store.
 */
export const BRIDGE_TIMEOUT_MS = 50_000;

/**
 * The nightly's first request, asked alone. Every run on Vercel comes from an address the
 * Bridge has not seen, and from 25 to 28 Sep 2026 two windows asked at once from one new
 * address failed with the Bridge's 500 page on 16 of 18 runs, while the same pair from a
 * laptop the Bridge already knew got 200s. So the newest window goes first, and the older
 * one after it answers. 30 s outlasts the 25 s refresh seen on 24 Sep and leaves the second
 * at least 20 of BRIDGE_TIMEOUT_MS.
 */
export const FIRST_ASK_MS = 30_000;

export const GIST_CHARS = 160;

/**
 * What an error body says, safe to store and show: markup dropped, every digit masked, cut
 * short. From 25 to 27 Sep 2026 the Bridge answered Vercel with a 500 on 10 of 12 nightly
 * runs while the same requests from a laptop got 200s, and a bare status could not say
 * why. Digits are masked because an amount is the one thing an error could plausibly echo
 * (invariant 4); a payee is not, and masking letters would leave nothing to read.
 */
export function gist(body: string): string {
  const text = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\d/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > GIST_CHARS ? `${text.slice(0, GIST_CHARS - 1)}…` : text;
}

type One =
  { readonly ok: true; readonly rows: Rows } | { readonly ok: false; readonly reason: string };

async function one(
  credential: Access,
  window: Window,
  options: PullOptions,
  timeoutMs: number,
): Promise<One> {
  let response: Response;
  try {
    response = await options.fetch(accountsUrl(credential.base, window), {
      headers: { Authorization: credential.authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    return { ok: false, reason: `the Bridge did not answer (${name})` };
  }
  if (response.status === 403) {
    return {
      ok: false,
      reason: 'the Bridge refused the access URL (403); it may have been revoked',
    };
  }
  if (!response.ok) {
    const said = gist(await response.text().catch(() => ''));
    const quoted = said === '' ? '' : `: "${said}"`;
    return { ok: false, reason: `the Bridge answered HTTP ${response.status}${quoted}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'the Bridge answered with something other than JSON' };
  }
  const set = parseAccountSet(body);
  // Counted, not quoted: an issue's path can name an account.
  if (!set.ok) {
    return {
      ok: false,
      reason: `the Bridge's answer did not parse (${set.issues.length} issue(s))`,
    };
  }
  const rows = toRows(set.value);
  options.onWindow?.(window, rows.transactions.length);
  return { ok: true, rows };
}

/**
 * `wanted` windows, newest first, into one set of rows — or the reason there is none. All or
 * nothing: a window that fails fails the pull, and tomorrow's run reads the same 90 days
 * again, so nothing is lost by storing nothing today.
 */
export async function pull(
  credential: Access,
  wanted: readonly Window[],
  options: PullOptions,
): Promise<Pulled> {
  const clock = options.clock ?? Date.now;
  const perRequest = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  const deadline = options.budgetMs === undefined ? Infinity : clock() + options.budgetMs;
  const covered: Window[] = [];
  const answers: One[] = [];
  if (options.order === 'together') {
    const timeout = Math.min(perRequest, deadline - clock());
    answers.push(...(await Promise.all(wanted.map((w) => one(credential, w, options, timeout)))));
    covered.push(...wanted);
  } else {
    for (const window of wanted) {
      const left = deadline - clock();
      if (left <= 0) {
        const reason = `no time was left to ask for window ${answers.length + 1}`;
        return { ok: false, reason, requests: answers.length };
      }
      const answer = await one(credential, window, options, Math.min(perRequest, left));
      answers.push(answer);
      covered.push(window);
      if (!answer.ok) break;
      const empty = answer.rows.transactions.length === 0 && answers.length > 1;
      if (options.order === 'untilEmpty' && empty) break;
    }
  }

  const requests = answers.length;
  const pulled: Rows[] = [];
  for (const answer of answers) {
    if (!answer.ok) return { ok: false, reason: answer.reason, requests };
    pulled.push(answer.rows);
  }
  return { ok: true, rows: combine(pulled), covered, requests };
}
