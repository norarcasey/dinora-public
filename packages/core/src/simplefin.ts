/**
 * SimpleFIN's account set, read into Dinora's rows.
 *
 * Protocol version 2, asked for by name (`version=2`): it names the institution through
 * `connections` and reports problems as coded `errlist` entries, where version 1 put an
 * `org` on every account and sent bare strings. Both were fetched from the Bridge's demo on
 * 24 Sep 2026; the shapes below are what came back, not only what the spec says.
 *
 * Only what Dinora keeps is described. Zod drops the rest — `mcc`, `extra`, holdings'
 * detail — so a field the Bridge adds later cannot fail a pull.
 */
import { z } from 'zod';

import { minorDigits, toMinor } from './money.ts';
import { parse } from './parse.ts';
import { signingIn } from './signing-in.ts';

const epochSeconds = z.number().int().nonnegative();

const transactionSchema = z.object({
  id: z.string().min(1),
  /** 0 while pending. */
  posted: epochSeconds,
  amount: z.string(),
  description: z.string(),
  payee: z.string().optional(),
  memo: z.string().optional(),
  transacted_at: epochSeconds.optional(),
  pending: z.boolean().optional(),
});

const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  conn_id: z.string(),
  /** ISO 4217, or a URL for a currency of the institution's own. */
  currency: z.string(),
  balance: z.string(),
  'available-balance': z.string().optional(),
  'balance-date': epochSeconds,
  transactions: z.array(transactionSchema).default([]),
  /** Counted and nothing more, until `BANK-04` decides whether they are enough. */
  holdings: z.array(z.unknown()).default([]),
});

const accountSetSchema = z.object({
  errlist: z
    .array(
      z.object({
        code: z.string(),
        msg: z.string(),
        conn_id: z.string().optional(),
        account_id: z.string().optional(),
      }),
    )
    .default([]),
  connections: z
    .array(
      z.object({
        conn_id: z.string(),
        name: z.string(),
        org_name: z.string().optional(),
      }),
    )
    .default([]),
  accounts: z.array(accountSchema),
});

export type AccountSet = z.output<typeof accountSetSchema>;

export function parseAccountSet(input: unknown) {
  return parse(accountSetSchema, input);
}

/** An account as Dinora keeps it. Keys are the table's columns. */
export type AccountRow = {
  readonly source_id: string;
  readonly institution: string;
  readonly name: string;
  readonly currency: string;
  readonly balance_minor: number;
  readonly available_minor: number | null;
  /** When the bank says the balance was true, not when it was fetched. */
  readonly balance_at: string;
  /**
   * How many holdings the Bridge listed. Counted, not described, until `BANK-04`; stored
   * because an account with any is an investment, whose past `bank_store` must not rebuild
   * from transactions (ACCT-03).
   */
  readonly holdings: number;
};

export type TransactionRow = {
  readonly account_source_id: string;
  readonly source_id: string;
  readonly posted_at: string | null;
  readonly transacted_at: string | null;
  readonly amount_minor: number;
  readonly description: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly pending: boolean;
};

/**
 * Something left out of a pull, and why. `label` is the account as she knows it — its bank and
 * its name — because the home screen says which account to look at (BANK-13). Never quotes an
 * amount or a payee (invariant 4).
 */
export type Skip = {
  readonly account: string;
  readonly label: string;
  readonly why: string;
} & (
  | { readonly kind: 'account' }
  | { readonly kind: 'available' }
  | { readonly kind: 'transaction'; readonly transaction: string }
);

export type Rows = {
  readonly accounts: readonly AccountRow[];
  readonly transactions: readonly TransactionRow[];
  readonly skipped: readonly Skip[];
  /** The Bridge's own complaints, as it worded them. */
  readonly errors: readonly string[];
  /**
   * Accounts kept with a transaction missing, because it could not be read. An account
   * skipped whole is not here: nothing of it is stored, so it cannot be wrong.
   */
  readonly partial: readonly string[];
};

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * A blank currency read as dollars. Found 26 Sep 2026: Vanguard sends its one account, a
 * 401(k), with `currency: ""`, and every night since the first it was skipped whole — its
 * balance missing from net worth, and the home screen saying only *2 row(s) could not be
 * read*. Nora chose dollars over asking per account: every other account the Bridge reads for
 * her says `USD`, a 401(k) is a US plan, and her euro bank comes through Enable Banking, not
 * the Bridge. A currency that is present and wrong is still refused.
 */
const BLANK_CURRENCY = 'USD';

/**
 * The account as the home screen names it: its bank, then its own name. The bank comes first
 * because `warnedAccounts` finds the accounts a warning is about by their bank's name.
 * `; ` separates one warning from the next in a stored detail, so it cannot appear inside one.
 */
export function accountLabel(institution: string, name: string, id: string): string {
  const own = name.trim() === '' ? `account ${id}` : name.trim();
  const label = institution === '' ? own : `${institution}'s ${own}`;
  return label.replaceAll('; ', ', ');
}

/**
 * One account set into rows. An account whose currency or balance cannot be read exactly is
 * skipped whole, with its transactions: a balance stored wrong is worse than one missing,
 * because nobody goes looking for it. A transaction that cannot be read is skipped alone.
 */
export function toRows(set: AccountSet): Rows {
  const institutions = new Map(set.connections.map((c) => [c.conn_id, c.org_name ?? c.name]));
  const accounts: AccountRow[] = [];
  const transactions: TransactionRow[] = [];
  const skipped: Skip[] = [];
  const partial = new Set<string>();

  for (const account of set.accounts) {
    const institution = institutions.get(account.conn_id) ?? '';
    const about = {
      account: account.id,
      label: accountLabel(institution, account.name, account.id),
    };
    const currency = account.currency.trim() === '' ? BLANK_CURRENCY : account.currency;
    const digits = minorDigits(currency);
    if (digits === null) {
      skipped.push({ ...about, kind: 'account', why: 'its currency is not an ISO 4217 code' });
      continue;
    }
    const balance = toMinor(account.balance, digits);
    if (!balance.ok) {
      skipped.push({
        ...about,
        kind: 'account',
        why: `its balance is not an exact ${currency} amount`,
      });
      continue;
    }
    let available: number | null = null;
    const availableText = account['available-balance'];
    if (availableText !== undefined) {
      const parsed = toMinor(availableText, digits);
      if (parsed.ok) available = parsed.minor;
      else skipped.push({ ...about, kind: 'available', why: 'unreadable, kept as none' });
    }

    accounts.push({
      source_id: account.id,
      institution,
      name: account.name,
      currency,
      balance_minor: balance.minor,
      available_minor: available,
      balance_at: iso(account['balance-date']),
      holdings: account.holdings.length,
    });

    for (const t of account.transactions) {
      const amount = toMinor(t.amount, digits);
      if (!amount.ok) {
        skipped.push({
          ...about,
          kind: 'transaction',
          transaction: t.id,
          why: 'its amount is not an exact amount',
        });
        partial.add(account.id);
        continue;
      }
      transactions.push({
        account_source_id: account.id,
        source_id: t.id,
        posted_at: t.posted === 0 ? null : iso(t.posted),
        transacted_at: t.transacted_at === undefined ? null : iso(t.transacted_at),
        amount_minor: amount.minor,
        description: t.description,
        payee: t.payee ?? null,
        memo: t.memo ?? null,
        pending: t.pending === true || t.posted === 0,
      });
    }
  }

  const errors = set.errlist.map((e) => complaint(e, institutions));
  return { accounts, transactions, skipped, errors, partial: [...partial] };
}

/**
 * One request's span. The Bridge caps a request at 90 days, and on 24 Sep 2026 its demo
 * answered a 90-day window with "exceeds recommended range of 45 days. In the future, this
 * may be capped." So 45, which costs twice the requests for the same depth and will not
 * quietly lose half of every window when the cap moves.
 */
export const WINDOW_DAYS = 45;

export type Window = { readonly start: number; readonly end: number };

/** `count` back-to-back windows ending at `now`, newest first, in epoch seconds. */
export function windows(now: number, count: number): Window[] {
  const span = WINDOW_DAYS * 86_400;
  return Array.from({ length: count }, (_, i) => ({
    start: now - (i + 1) * span,
    end: now - i * span,
  }));
}

/**
 * How far back the Bridge answers at all. Measured on BofA's first link (BANK-01, 24 Sep
 * 2026): the earliest transaction was exactly 90 days old and the window before it empty.
 */
export const HISTORY_DAYS = 90;

/** The nightly pull re-reads all of that history — two requests of the 24 a day allowed. */
export const NIGHTLY_WINDOWS = Math.ceil(HISTORY_DAYS / WINDOW_DAYS);

/**
 * How far inside what a pull covered a missing transaction must be dated before it counts as
 * dropped. The edge of the Bridge's history is where a transaction leaves the answer for
 * reasons that are not the bank's — it aged out, or it was posted a day after the date the
 * window filters on — and a margin this wide makes that impossible to mistake for a drop.
 * Chosen, not measured: nothing yet has been seen dropping.
 */
export const DROP_MARGIN_DAYS = 30;

/**
 * From when a transaction missing from this pull may be marked dropped, or null to mark
 * nothing. Null when the pull was incomplete — the Bridge complained, or a row could not be
 * read and so is missing for Dinora's reasons rather than the bank's — because an absence
 * in a partial answer is not evidence of anything.
 */
export function dropsFrom(rows: Rows, covered: readonly Window[], now: number): string | null {
  if (covered.length === 0 || rows.errors.length > 0 || rows.skipped.length > 0) return null;
  const from = edge(covered, now) + DROP_MARGIN_DAYS * 86_400;
  return from < now ? iso(from) : null;
}

/** The oldest moment the pull could have seen: what it asked for, as far as the Bridge goes. */
function edge(covered: readonly Window[], now: number): number {
  const oldest = Math.min(...covered.map((w) => w.start));
  return Math.max(oldest, now - HISTORY_DAYS * 86_400);
}

/**
 * From when this pull holds every settled transaction of every account it stored, or null
 * when it may not (ACCT-03). `bank_store` rebuilds an account's balance back to this date,
 * through days with no transaction at all: an idle savings account was flat, and leaving it
 * out until its first reading would make a net worth jump by its whole balance that day.
 *
 * Null when the Bridge complained or a transaction could not be read, and then an account
 * is rebuilt only from its own earliest transaction. Unlike `dropsFrom`, an account skipped
 * whole does not count: none of it is stored, so no balance is walked back through it.
 * Reasoned from BANK-01's measurement that the Bridge answers the full 90 days; a bank that
 * gave less would make the flat stretch before its first transaction wrong.
 */
export function historyFrom(rows: Rows, covered: readonly Window[], now: number): string | null {
  if (covered.length === 0 || rows.errors.length > 0 || rows.partial.length > 0) return null;
  return iso(edge(covered, now));
}

/**
 * One of the Bridge's complaints, as the home screen will say it. A connection that wants
 * signing in again (`con.auth`) is said in the words Plaid's are (`signInAgain`), with the
 * bank named from the connection it came with, so the home screen offers the same fix for
 * both (BANK-13). Anything else keeps the Bridge's code and words.
 */
function complaint(
  e: AccountSet['errlist'][number],
  institutions: ReadonlyMap<string, string>,
): string {
  const bank = e.conn_id === undefined ? undefined : connection(e.conn_id, institutions);
  if (e.code === 'con.auth' && bank !== undefined) return signingIn(bank.replaceAll('; ', ', '));
  return `${e.code}: ${e.msg}`;
}

/**
 * The bank a complaint's `conn_id` names. Measured 26 Sep 2026: the Bridge's `errlist` said
 * `MBR-1d1eab0c-…` of the connection its own `connections` listed as `MX-MBR-1d1eab0c-…`
 * (Northwind), the aggregator's prefix dropped. So an exact match, or one ending in it.
 */
function connection(id: string, institutions: ReadonlyMap<string, string>): string | undefined {
  const exact = institutions.get(id);
  if (exact !== undefined) return exact;
  for (const [conn, bank] of institutions) if (conn.endsWith(`-${id}`)) return bank;
  return undefined;
}

/**
 * What a run records about itself beyond its counts: the Bridge's complaints, then each
 * account something was left out of, once, by its bank and name. Until 26 Sep 2026 the skips
 * were only counted — *2 row(s) could not be read* — because the list named accounts; but a
 * count cannot be acted on, it counted one account once per window, and an account's name is
 * neither an amount nor a payee (invariant 4). The nightly job logs its outcome, never this.
 */
export function detail(rows: Rows): string {
  const parts = [...rows.errors];
  const byAccount = new Map<string, Skip[]>();
  for (const skip of rows.skipped) {
    byAccount.set(skip.account, [...(byAccount.get(skip.account) ?? []), skip]);
  }
  for (const skips of byAccount.values()) parts.push(...said(skips));
  return parts.join('; ').slice(0, 2000);
}

function said(skips: readonly Skip[]): string[] {
  const [first] = skips;
  if (first === undefined) return [];
  const whole = skips.find((s) => s.kind === 'account');
  if (whole !== undefined) return [`${whole.label} was left out: ${whole.why}`];
  const lines: string[] = [];
  if (skips.some((s) => s.kind === 'available')) {
    lines.push(`${first.label}'s available balance could not be read`);
  }
  const unread = new Set(skips.flatMap((s) => (s.kind === 'transaction' ? [s.transaction] : [])));
  if (unread.size > 0) {
    lines.push(
      `${first.label}: ${unread.size} transaction${unread.size === 1 ? '' : 's'} could not be read`,
    );
  }
  return lines;
}

/**
 * Several windows' rows into one set. Accounts come from the newest window, whose balances
 * are the ones to keep; a transaction seen twice — one on a boundary, or pending in one
 * window and posted in the next — is kept as the newest window saw it.
 */
export function combine(newestFirst: readonly Rows[]): Rows {
  const [newest] = newestFirst;
  if (newest === undefined) {
    return { accounts: [], transactions: [], skipped: [], errors: [], partial: [] };
  }
  const seen = new Set<string>();
  const transactions: TransactionRow[] = [];
  for (const rows of newestFirst) {
    for (const t of rows.transactions) {
      const key = `${t.account_source_id}\u0000${t.source_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      transactions.push(t);
    }
  }
  return {
    accounts: newest.accounts,
    transactions,
    skipped: newestFirst.flatMap((r) => r.skipped),
    errors: [...new Set(newestFirst.flatMap((r) => r.errors))],
    partial: [...new Set(newestFirst.flatMap((r) => r.partial))],
  };
}

type Sign = 'negative' | 'zero' | 'positive';

function sign(n: number): Sign {
  return n < 0 ? 'negative' : n > 0 ? 'positive' : 'zero';
}

export type AccountReport = {
  readonly institution: string;
  readonly name: string;
  readonly currency: string;
  readonly balance: Sign;
  readonly available: Sign | 'absent';
  readonly balanceAt: string;
  readonly transactions: number;
  readonly pending: number;
  readonly credits: number;
  readonly debits: number;
  readonly earliest: string | null;
  readonly latest: string | null;
  readonly holdings: number;
};

/**
 * What came back, safe to print: counts, dates and signs. No amount and no payee, a spike
 * included (invariant 4) — how a card's balance is signed is answered by its sign alone.
 */
export function report(rows: Rows): AccountReport[] {
  return rows.accounts.map((account) => {
    const mine = rows.transactions.filter((t) => t.account_source_id === account.source_id);
    const dates = mine
      .map((t) => t.posted_at ?? t.transacted_at)
      .filter((d) => d !== null)
      .sort();
    return {
      institution: account.institution,
      name: account.name,
      currency: account.currency,
      balance: sign(account.balance_minor),
      available: account.available_minor === null ? 'absent' : sign(account.available_minor),
      balanceAt: account.balance_at.slice(0, 10),
      transactions: mine.length,
      pending: mine.filter((t) => t.pending).length,
      credits: mine.filter((t) => t.amount_minor > 0).length,
      debits: mine.filter((t) => t.amount_minor < 0).length,
      earliest: dates[0]?.slice(0, 10) ?? null,
      latest: dates.at(-1)?.slice(0, 10) ?? null,
      holdings: account.holdings,
    };
  });
}
