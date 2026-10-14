import { z } from 'zod';

import { minorDigits } from './money.ts';

/**
 * What the balances screen says (ACCT-01): every account's balance as the bank last reported
 * it, how old that report is, and when Dinora last managed to read the bank at all.
 *
 * Three different times, kept apart because each answers a different worry:
 *
 *   * `balance_at` — when the bank says the balance was true. A bank the aggregator could not
 *     refresh keeps an old one, and has to look old (`isStale`).
 *   * the newest `ok` pull — when the nightly job last stored anything (`lastRead`).
 *   * when this device last heard from the server — the app's, not this module's.
 *
 * Balances are the bank's own figures, not a sum of transactions, so `dropped_at` on a
 * transaction does not enter anything here.
 */

/** Rows as PostgREST sends them: snake_case, timestamps as ISO text with an offset. */
const timestamp = z.iso.datetime({ offset: true });

export const accountRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  institution: z.string(),
  name: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  // `z.int()` is a safe integer: past 2^53 a bigint column would arrive already rounded.
  balance_minor: z.int(),
  balance_at: timestamp,
  // How many holdings the Bridge lists (ACCT-03): the strongest sign an account is invested.
  holdings: z.int().nonnegative(),
  // Who reads it: a bank's aggregator, or `monarch` for history only Monarch had (BANK-15).
  source: z.string(),
});

export type AccountRow = z.output<typeof accountRowSchema>;

export const pullRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  source: z.string(),
  outcome: z.enum(['ok', 'failed']),
  finished_at: timestamp,
  detail: z.string(),
});

export type PullRow = z.output<typeof pullRowSchema>;

/** By bank, then by name — the order a person scans a statement drawer in. */
export function compareAccounts(a: AccountRow, b: AccountRow): number {
  return (
    a.institution.localeCompare(b.institution) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

/* ─── when the bank was last read ───────────────────────────────────────────────────────── */

export type Failure = { readonly at: string; readonly detail: string };

export type LastRead =
  /** No pull has ever succeeded. `failed` is the newest attempt that did not. */
  | { readonly kind: 'never'; readonly failed: Failure | null }
  /**
   * `failed` is set only when a pull failed after the newest success: that is news.
   * `warnings` are what the newest success said beside its rows (BANK-09).
   */
  | {
      readonly kind: 'read';
      readonly at: string;
      readonly failed: Failure | null;
      readonly warnings: readonly string[];
    };

/**
 * The newest `ok` pull, and the newest failure if it came after it (BANK-02's rule). A
 * failure followed by a success is history, not news, and is not shown. Compared by parsed
 * time, not text: `finished_at` carries an offset, and two offsets do not sort as strings.
 */
export function lastRead(pulls: readonly PullRow[]): LastRead {
  let ok: PullRow | null = null;
  let failed: PullRow | null = null;
  for (const pull of pulls) {
    if (pull.deleted_at !== null) continue;
    if (pull.outcome === 'ok') {
      if (ok === null || later(pull.finished_at, ok.finished_at)) ok = pull;
    } else if (failed === null || later(pull.finished_at, failed.finished_at)) {
      failed = pull;
    }
  }
  if (ok === null) return { kind: 'never', failed: failed === null ? null : failure(failed) };
  const news = failed !== null && later(failed.finished_at, ok.finished_at) ? failed : null;
  return {
    kind: 'read',
    at: ok.finished_at,
    failed: news === null ? null : failure(news),
    warnings: warnings(ok.detail),
  };
}

/**
 * A successful pull's detail, one complaint each (`detail` in simplefin.ts joins them with
 * `; `). Found 26 Sep 2026: the Bridge said PSCU and Northwind needed signing in again, in an
 * answer that was otherwise fine; their balances had not moved since 24 Sep and nothing on
 * screen said so. The Bridge's code (`con.auth: `) is dropped; its message already
 * says what is wrong in words. A message holding `; ` itself splits in two, which costs a
 * line break and nothing else.
 */
function warnings(detail: string): string[] {
  return detail
    .split('; ')
    .map((part) => part.replace(/^[a-z]+(?:\.[a-z_]+)+: /, '').trim())
    .filter((part) => part !== '');
}

export type SourceRead = { readonly source: string; readonly read: LastRead };

/**
 * The accounts a warning is about: those whose bank it names, so the home screen can take her
 * straight to them. A warning is kept only as words, the aggregator's code and message, so the
 * bank's name in them is what ties the two. Checked against the Bridge on 26 Sep 2026: its
 * complaint says *Connection to Northwind may need attention*, in the very name its connection
 * gives the accounts' `institution`, for all nine banks linked; and Plaid's `signInAgain` words
 * use `/item/get`'s `institution_name`, which is what its accounts carry (BANK-07). Whole words
 * and any case, so *Bank of America* is not found inside another bank's name.
 */
export function warnedAccounts(warning: string, accounts: readonly AccountRow[]): AccountRow[] {
  return accounts
    .filter((a) => a.deleted_at === null && a.institution.trim() !== '')
    .filter((a) => wholeWords(a.institution.trim()).test(warning))
    .sort(compareAccounts);
}

function wholeWords(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * `lastRead` for each source on its own, by name (BANK-07). Over all of them at once, a
 * Plaid success a second after a SimpleFIN failure would count as answering it, and the
 * failure would never be shown.
 */
export function lastReads(pulls: readonly PullRow[]): SourceRead[] {
  const live = pulls.filter((p) => p.deleted_at === null);
  return [...new Set(live.map((p) => p.source))]
    .sort()
    .map((source) => ({ source, read: lastRead(live.filter((p) => p.source === source)) }));
}

const SOURCE_NAMES: Readonly<Record<string, string>> = { simplefin: 'SimpleFIN', plaid: 'Plaid' };

export function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source;
}

function later(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

function failure(pull: PullRow): Failure {
  return { at: pull.finished_at, detail: pull.detail };
}

/* ─── how old a balance is ──────────────────────────────────────────────────────────────── */

/**
 * Past this, the bank's own figure has missed at least one night. The pull runs at 09:00 and
 * 11:00 UTC (`vercel.json`), so a bank that refreshed is never more than about 26 hours old
 * just before the next run; 36 leaves room for Hobby firing late in its hour. A reasoned
 * number, not a measured one: production's actual `balance_at` ages were not read (24 Sep).
 */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export function isStale(balanceAt: string, now: number): boolean {
  return now - Date.parse(balanceAt) > STALE_AFTER_MS;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 hours ago", "yesterday", "just now". Coarse on purpose: to the minute for the first hour,
 * where a fresh read is worth seeing as fresh, then hours, then days. A time in the future — a
 * clock behind the server's — reads as just now rather than "in 2 minutes".
 */
export function describeAge(at: string, now: number, locale: string | undefined): string {
  const age = Math.max(0, now - Date.parse(at));
  if (age < MINUTE) return 'just now';
  const words = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (age < HOUR) return words.format(-Math.floor(age / MINUTE), 'minute');
  if (age < DAY) return words.format(-Math.floor(age / HOUR), 'hour');
  return words.format(-Math.floor(age / DAY), 'day');
}

/* ─── totals ────────────────────────────────────────────────────────────────────────────── */

export type Total = {
  readonly currency: string;
  /** Summed as a bigint: a sum is where a float would drift, and no sum here can overflow. */
  readonly minor: bigint;
  readonly accounts: number;
};

/**
 * One total per currency, never one across them: adding euros to dollars needs a rate and a
 * date for it (invariant 3), which is ACCT-02's. Cards arrive negative when owed (BANK-01), so
 * each total is a net worth for that currency with no flip per account type.
 */
export function totalsByCurrency(accounts: readonly AccountRow[]): Total[] {
  const sums = new Map<string, { minor: bigint; accounts: number }>();
  for (const account of accounts) {
    if (account.deleted_at !== null) continue;
    const held = sums.get(account.currency) ?? { minor: 0n, accounts: 0 };
    held.minor += BigInt(account.balance_minor);
    held.accounts += 1;
    sums.set(account.currency, held);
  }
  return [...sums]
    .map(([currency, { minor, accounts }]) => ({ currency, minor, accounts }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/* ─── showing an amount ─────────────────────────────────────────────────────────────────── */

type NumericText = `${number}`;

function isNumericText(text: string): text is NumericText {
  return /^-?\d+(\.\d+)?$/.test(text);
}

/**
 * -123456 USD is "-$1,234.56". The integer becomes decimal text by moving the point, and
 * `Intl.NumberFormat` formats that text exactly — dividing by 100 first would put the float
 * back in at the last step, the one the person reads.
 */
export function formatMinor(
  minor: number | bigint,
  currency: string,
  locale: string | undefined,
): string {
  const digits = minorDigits(currency) ?? 2;
  const units = BigInt(minor);
  const negative = units < 0n;
  const padded = (negative ? -units : units).toString().padStart(digits + 1, '0');
  const whole = padded.slice(0, padded.length - digits);
  const text = `${negative ? '-' : ''}${whole}${digits === 0 ? '' : `.${padded.slice(-digits)}`}`;
  // Always numeric by construction; the guard is how the compiler is told without a cast.
  if (!isNumericText(text)) throw new Error('formatMinor built a malformed number');
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(text);
}

/* ─── banks that have stopped moving ────────────────────────────────────────────────────── */

export type StaleBank = {
  readonly source: string;
  readonly institution: string;
  /** Its accounts that have missed a night, in the drawer's order. */
  readonly accounts: readonly AccountRow[];
  /** The newest balance any of them has: when the aggregator last heard from the bank. */
  readonly since: string;
};

/**
 * Each bank an aggregator reads whose balances have missed a night (`isStale`) with nothing
 * said about it, by source (BANK-18). Found 28 Sep 2026: SUMMIT's four accounts were 40 hours
 * old at the Bridge itself, whose `errlist` was empty, so the home screen showed four amber
 * rows and offered nothing to do about them. A bank a warning names is left out: its fix is
 * under the warning (`Fix` in Dashboard.tsx), and a bank should be asked about in one place.
 * Monarch's accounts are left out too: nothing reads them, so nothing can read them again.
 */
export function staleBanks(
  accounts: readonly AccountRow[],
  warnings: readonly string[],
  now: number,
): StaleBank[] {
  const byBank = new Map<string, AccountRow[]>();
  for (const a of accounts) {
    if (a.deleted_at !== null || !Object.hasOwn(SOURCE_NAMES, a.source)) continue;
    if (!isStale(a.balance_at, now)) continue;
    const bank = a.institution.trim();
    if (bank !== '' && warnings.some((w) => wholeWords(bank).test(w))) continue;
    const key = `${a.source}\n${bank}`;
    byBank.set(key, [...(byBank.get(key) ?? []), a]);
  }
  return [...byBank.entries()]
    .map(([key, rows]) => {
      const [source = '', institution = ''] = key.split('\n');
      const sorted = [...rows].sort(compareAccounts);
      const since = sorted.map((r) => r.balance_at).reduce((a, b) => (later(b, a) ? b : a));
      return { source, institution, accounts: sorted, since };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.institution.localeCompare(b.institution));
}
