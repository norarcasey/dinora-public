/**
 * Monarch's CSV export, read into what `public.monarch_store` takes (ACCT-05).
 *
 * Two files, both from Monarch's web app, read on 24 Sep 2026 from Nora's own export:
 *
 *   Transactions_<time>.csv   Date, Merchant, Category, Account, Original Statement, Notes,
 *                             Amount, Tags, Owner, Reviewed, Id
 *   Balances_<time>.csv       Date, Balance, Account — one row per account per day
 *
 * Dates are ISO days, amounts decimal text with two places, and signs the cardholder's, as
 * SimpleFIN's are (`BANK-01`): a card owed is negative. Monarch names no currency; every
 * account it held was in dollars, so the import says USD and a linked account in anything
 * else is refused by the store.
 *
 * Which Monarch account is which of Dinora's is Nora's to confirm, not this module's to
 * decide: `proposeMapping` guesses from the last four digits, writes the guess down, and
 * the import runs only from a mapping she has marked confirmed.
 */
import { z } from 'zod';

import type { AssetKind } from './assets.ts';
import { ASSET_KINDS } from './assets.ts';

import { toMinor } from './money.ts';
import { parse } from './parse.ts';

/* ─── CSV ───────────────────────────────────────────────────────────────────────────────── */

/**
 * RFC 4180: quoted fields may hold commas, quotes (doubled) and line breaks. Null for a
 * quote left open, which means the file was cut short — better refused than read as one
 * enormous last field.
 */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.startsWith('\uFEFF') ? text.slice(1) : text;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) return null;
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type Read<T> =
  | { readonly ok: true; readonly rows: readonly T[]; readonly skipped: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Rows as records by header, refusing a file that lacks a column the import reads. */
function records(
  text: string,
  columns: readonly string[],
): { ok: true; rows: Record<string, string>[] } | { ok: false; reason: string } {
  const table = parseCsv(text);
  if (table === null) return { ok: false, reason: 'a quoted field is never closed' };
  const [header, ...body] = table;
  if (header === undefined) return { ok: false, reason: 'the file is empty' };
  const missing = columns.filter((c) => !header.includes(c));
  if (missing.length > 0) return { ok: false, reason: `no ${missing.join(', ')} column` };
  const rows = body
    .filter((cells) => !(cells.length === 1 && cells[0] === ''))
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  return { ok: true, rows };
}

/** Empty text is Monarch's "none". */
const optional = z.string().transform((s) => (s === '' ? null : s));

/* ─── transactions ──────────────────────────────────────────────────────────────────────── */

const TRANSACTION_COLUMNS = [
  'Date',
  'Merchant',
  'Category',
  'Account',
  'Original Statement',
  'Notes',
  'Amount',
  'Tags',
  'Id',
] as const;

const transactionSchema = z.object({
  Date: z.iso.date(),
  Merchant: optional.pipe(z.string().max(500).nullable()),
  Category: optional.pipe(z.string().max(500).nullable()),
  Account: z.string().min(1).max(500),
  'Original Statement': z.string().max(2000),
  Notes: optional.pipe(z.string().max(2000).nullable()),
  Amount: z.string(),
  Tags: z.string(),
  Id: z.string().regex(/^\d{1,40}$/),
});

export type MonarchTransaction = {
  readonly account: string;
  readonly id: string;
  readonly on_date: string;
  readonly amount_minor: number;
  readonly payee: string | null;
  readonly description: string;
  readonly memo: string | null;
  readonly category: string | null;
  readonly tagged: boolean;
};

/**
 * The transactions file. A row that cannot be read is skipped alone, and said so by its
 * line and the column at fault — never its amount or its merchant (invariant 4). A second
 * row with an id already read is skipped: one statement cannot upsert a key twice, and two
 * rows claiming one id cannot both be right.
 */
export function readTransactions(text: string): Read<MonarchTransaction> {
  const table = records(text, TRANSACTION_COLUMNS);
  if (!table.ok) return table;
  const rows: MonarchTransaction[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  table.rows.forEach((record, i) => {
    const line = i + 2;
    const parsed = parse(transactionSchema, record);
    if (!parsed.ok) {
      skipped.push(`line ${line}: ${columnsAtFault(parsed.issues)} unreadable`);
      return;
    }
    const r = parsed.value;
    const amount = toMinor(r.Amount, 2);
    if (!amount.ok) {
      skipped.push(`line ${line}: Amount is not an exact dollar amount`);
      return;
    }
    const key = `${r.Account}\u0000${r.Id}`;
    if (seen.has(key)) {
      skipped.push(`line ${line}: Id repeats an earlier row`);
      return;
    }
    seen.add(key);
    rows.push({
      account: r.Account,
      id: r.Id,
      on_date: r.Date,
      amount_minor: amount.minor,
      payee: r.Merchant,
      description: r['Original Statement'],
      memo: r.Notes,
      category: r.Category,
      tagged: r.Tags !== '',
    });
  });
  return { ok: true, rows, skipped };
}

/* ─── balances ──────────────────────────────────────────────────────────────────────────── */

const balanceSchema = z.object({
  Date: z.iso.date(),
  Balance: z.string(),
  Account: z.string().min(1).max(500),
});

export type MonarchBalance = {
  readonly account: string;
  readonly on_date: string;
  readonly balance_minor: number;
};

/** The balances file, one row per account per day; a second row for a day is skipped. */
export function readBalances(text: string): Read<MonarchBalance> {
  const table = records(text, ['Date', 'Balance', 'Account']);
  if (!table.ok) return table;
  const rows: MonarchBalance[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  table.rows.forEach((record, i) => {
    const line = i + 2;
    const parsed = parse(balanceSchema, record);
    if (!parsed.ok) {
      skipped.push(`line ${line}: ${columnsAtFault(parsed.issues)} unreadable`);
      return;
    }
    const r = parsed.value;
    const balance = toMinor(r.Balance, 2);
    if (!balance.ok) {
      skipped.push(`line ${line}: Balance is not an exact dollar amount`);
      return;
    }
    const key = `${r.Account}\u0000${r.Date}`;
    if (seen.has(key)) {
      skipped.push(`line ${line}: a second balance for the same account and day`);
      return;
    }
    seen.add(key);
    rows.push({ account: r.Account, on_date: r.Date, balance_minor: balance.minor });
  });
  return { ok: true, rows, skipped };
}

/** `Amount: Invalid input` → `Amount`: the column, never the value. */
function columnsAtFault(issues: readonly string[]): string {
  return [...new Set(issues.map((issue) => issue.split(':')[0]))].join(', ');
}

/* ─── which account is which ────────────────────────────────────────────────────────────── */

/**
 * The four digits a name ends with in parentheses: Monarch writes `Savings (...0391)`, the
 * Bridge `Savings (0391)` (both read 24 Sep 2026). Digits anywhere else — a street number, a
 * model year — are not an account number, so they are not read as one.
 */
export function lastFour(name: string): string | null {
  const match = /\((?:\.\.\.)?(\d{4})\)\s*$/.exec(name);
  return match?.[1] ?? null;
}

export type DinoraAccount = {
  readonly source_id: string;
  readonly institution: string;
  readonly name: string;
};

/**
 * Where one Monarch account goes: into one of Dinora's (`link`, the Bridge's id), in as an
 * account only Monarch knows (`history`), in as something she owns (`asset`, ACCT-06), or
 * nowhere (`skip`).
 */
const targetSchema = z.union([
  z.object({ link: z.string().min(1), is: z.string().optional() }),
  // Not crypto (ACCT-21): a holding is a coin and a quantity, which Monarch's balances are not.
  z.object({ asset: z.enum(ASSET_KINDS).exclude(['crypto']) }),
  z.literal('history'),
  z.literal('skip'),
]);

export type Target = z.output<typeof targetSchema>;

const mappingSchema = z.object({
  confirmed: z.boolean(),
  accounts: z.record(z.string(), targetSchema),
});

export type Mapping = z.output<typeof mappingSchema>;

export function parseMapping(input: unknown) {
  return parse(mappingSchema, input);
}

/**
 * A guess, written for Nora to correct: a Monarch account links to the one Dinora account
 * whose last four digits it shares, and only when exactly one on each side has them — two
 * cards ending alike are hers to tell apart. Everything else is proposed as history; an
 * asset she does not want imported is hers to mark `skip`.
 */
export function proposeMapping(
  monarchNames: readonly string[],
  dinora: readonly DinoraAccount[],
): Mapping {
  const count = (digits: string[]) =>
    digits.reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map<string, number>());
  const ours = count(dinora.map((a) => lastFour(a.name)).filter((d) => d !== null));
  const theirs = count(monarchNames.map(lastFour).filter((d) => d !== null));

  const accounts: Record<string, Target> = {};
  for (const name of [...monarchNames].sort((a, b) => a.localeCompare(b))) {
    const digits = lastFour(name);
    const match =
      digits !== null && ours.get(digits) === 1 && theirs.get(digits) === 1
        ? dinora.find((a) => lastFour(a.name) === digits)
        : undefined;
    accounts[name] =
      match === undefined
        ? 'history'
        : { link: match.source_id, is: `${match.institution} · ${match.name}` };
  }
  return { confirmed: false, accounts };
}

/**
 * Monarch accounts whose four digits no Dinora account ends in. Proposed as history like any
 * other unmatched name, but a number is the sign of an account a bank reads, so this usually
 * means the database has not pulled it yet: the state ACCT-05's first production run met, where
 * 8 of 19 accounts were known and 11 were offered as history only (ACCT-07).
 */
export function strangers(
  monarchNames: readonly string[],
  dinora: readonly DinoraAccount[],
): string[] {
  const ours = new Set(dinora.map((a) => lastFour(a.name)));
  return monarchNames
    .filter((name) => {
      const digits = lastFour(name);
      return digits !== null && !ours.has(digits);
    })
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Why the store would refuse an account, found before anything is written (ACCT-07): a link
 * to no bank account, to a deleted one, to one in another currency, or to one with no day of
 * history to fill before; or `history` of an account deleted in Dinora, which the store's
 * lookup passes over.
 */
export const UNREADY_WHY = ['missing', 'deleted', 'currency', 'no_history'] as const;

export type Unready = {
  readonly monarch_name: string;
  readonly link: string | null;
  readonly why: (typeof UNREADY_WHY)[number];
};

export function describeUnready(u: Unready): string {
  if (u.link === null) {
    return `${u.monarch_name} is "history" of an account deleted in Dinora: mark it "skip"`;
  }
  const to = `${u.monarch_name} links to ${u.link}`;
  switch (u.why) {
    case 'missing':
      return `${to}, which no bank account in Dinora is`;
    case 'deleted':
      return `${to}, which is deleted in Dinora: mark it "skip" or link it elsewhere`;
    case 'currency':
      return `${to}, which is not in dollars`;
    case 'no_history':
      return `${to}, which has no day of history yet: run the nightly pull first`;
  }
}

/** An account as `--link` looks it up: which it is and whose, never its balance. */
export type LinkAccount = {
  readonly id: string;
  readonly source: string;
  readonly source_id: string;
  readonly institution: string;
  readonly name: string;
  readonly currency: string;
  readonly deleted_at: string | null;
};

/**
 * The mapping with one Monarch account linked to one bank account, as the home screen asks
 * when it finds the two counted twice (BANK-15). Both are named by Dinora's ids, which the
 * page has; the mapping keys on Monarch's name and links to the aggregator's id, which this
 * looks up. Refused, rather than guessed at, wherever the answer is not plainly "these two":
 * an account that is not what it is said to be, one already put together or deleted, two
 * currencies, a Monarch account she chose to skip or keep as an asset, or a bank account
 * another Monarch account already fills — whose days the second import would overwrite.
 */
export function linkPair(
  mapping: Mapping,
  accounts: readonly LinkAccount[],
  monarchId: string,
  bankId: string,
):
  | { readonly ok: true; readonly mapping: Mapping }
  | { readonly ok: false; readonly reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  const monarch = accounts.find((a) => a.id === monarchId);
  const bank = accounts.find((a) => a.id === bankId);
  if (monarch === undefined) return refuse(`no account ${monarchId}`);
  if (bank === undefined) return refuse(`no account ${bankId}`);
  if (monarch.source !== 'monarch') return refuse(`${monarch.name} is not Monarch's history`);
  if (monarch.deleted_at !== null) return refuse(`${monarch.name} was already put together`);
  if (bank.source !== 'simplefin' && bank.source !== 'plaid') {
    return refuse(`${bank.name} is not an account a bank reads`);
  }
  if (bank.deleted_at !== null) return refuse(`${bank.name} is deleted`);
  if (monarch.currency !== bank.currency) {
    return refuse(`${monarch.name} is in ${monarch.currency}, ${bank.name} in ${bank.currency}`);
  }
  const target = mapping.accounts[monarch.source_id];
  if (target === undefined) return refuse(`the mapping has no "${monarch.source_id}"`);
  if (target !== 'history') {
    return refuse(`the mapping has "${monarch.source_id}" as ${JSON.stringify(target)}`);
  }
  const taken = Object.entries(mapping.accounts).find(
    ([, t]) => typeof t === 'object' && 'link' in t && t.link === bank.source_id,
  );
  if (taken !== undefined) return refuse(`"${taken[0]}" already links to ${bank.name}`);
  return {
    ok: true,
    mapping: {
      ...mapping,
      accounts: {
        ...mapping.accounts,
        [monarch.source_id]: { link: bank.source_id, is: `${bank.institution} · ${bank.name}` },
      },
    },
  };
}

/* ─── the mapping kept in Dinora (ACCT-18) ──────────────────────────────────────────────── */

/**
 * One row of `public.monarch_decisions`: where one Monarch account goes, from when, and why.
 * The table keeps every decision, so the mapping is the latest of each account's.
 */
export const decisionSchema = z.object({
  monarch_name: z.string().min(1),
  goes: z.enum(['link', 'history', 'skip', 'asset']),
  link: z.string().nullable(),
  link_is: z.string().nullable(),
  asset_kind: z.string().nullable(),
  why: z.string(),
  decided_at: z.string(),
});

export type Decision = z.output<typeof decisionSchema>;

export function decisionOf(
  monarchName: string,
  target: Target,
  why: string,
  decidedAt: string,
): Decision {
  const row = { monarch_name: monarchName, why, decided_at: decidedAt };
  const none = { link: null, link_is: null, asset_kind: null };
  if (target === 'history' || target === 'skip') return { ...row, ...none, goes: target };
  if ('asset' in target) return { ...row, ...none, goes: 'asset', asset_kind: target.asset };
  return { ...row, ...none, goes: 'link', link: target.link, link_is: target.is ?? null };
}

/** Null for a row the file's schema would not have taken, which the table's checks refuse. */
export function targetOf(d: Decision): Target | null {
  const raw =
    d.goes === 'link'
      ? d.link_is === null
        ? { link: d.link }
        : { link: d.link, is: d.link_is }
      : d.goes === 'asset'
        ? { asset: d.asset_kind }
        : d.goes;
  const parsed = parse(targetSchema, raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * The mapping the decisions add up to: each account's latest by `decided_at`. Confirmed,
 * because nothing reaches the table unconfirmed — a proposal stays in its file until Nora has
 * read it. A refusal names the account whose latest row is not a target.
 */
export function mappingOf(
  decisions: readonly Decision[],
): { readonly ok: true; readonly mapping: Mapping } | { readonly ok: false; readonly bad: string } {
  const latest = new Map<string, Decision>();
  for (const d of decisions) {
    const seen = latest.get(d.monarch_name);
    if (seen === undefined || Date.parse(d.decided_at) > Date.parse(seen.decided_at)) {
      latest.set(d.monarch_name, d);
    }
  }
  const accounts: Record<string, Target> = {};
  for (const name of [...latest.keys()].sort((a, b) => a.localeCompare(b))) {
    const d = latest.get(name);
    const target = d === undefined ? null : targetOf(d);
    if (target === null) return { ok: false, bad: name };
    accounts[name] = target;
  }
  return { ok: true, mapping: { confirmed: true, accounts } };
}

/** Where two decisions send an account, compared as the table would store them. */
export function sameTarget(a: Target | undefined, b: Target): boolean {
  if (a === undefined) return false;
  return JSON.stringify(decisionOf('', a, '', '')) === JSON.stringify(decisionOf('', b, '', ''));
}

/** A mapping file as it stood at one moment: the current one, or one of the copies beside it. */
export type MappingCopy = {
  readonly file: string;
  readonly decided_at: string;
  readonly mapping: Mapping;
};

/**
 * The files, oldest first, as the decisions they record: an account's row wherever a file says
 * something the one before it did not. So the copies kept before each hand edit become the
 * table's history instead of being lost with the folder, each dated by the file's own time.
 * An unconfirmed copy was never imported, so it decided nothing and is passed over. An account
 * a later file leaves out keeps its last decision: dropping one never removed it from anything.
 */
export function replay(copies: readonly MappingCopy[]): Decision[] {
  const state = new Map<string, Target>();
  const decisions: Decision[] = [];
  const ordered = [...copies].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at));
  for (const copy of ordered) {
    if (!copy.mapping.confirmed) continue;
    for (const [name, target] of Object.entries(copy.mapping.accounts)) {
      if (sameTarget(state.get(name), target)) continue;
      state.set(name, target);
      decisions.push(decisionOf(name, target, `from ${copy.file}`, copy.decided_at));
    }
  }
  return decisions;
}

/**
 * `--as`: `history`, `skip`, `asset:<kind>` or `link:<the aggregator's id>`. Null for anything
 * else, including crypto, which the file refused as well.
 */
export function readTarget(text: string): Target | null {
  const [kind, ...rest] = text.split(':');
  const value = rest.join(':');
  const raw =
    kind === 'link'
      ? { link: value }
      : kind === 'asset'
        ? { asset: value }
        : rest.length > 0
          ? null
          : kind;
  const parsed = parse(targetSchema, raw);
  return parsed.ok ? parsed.value : null;
}

/* ─── what the store takes ──────────────────────────────────────────────────────────────── */

export type PayloadAccount = {
  readonly monarch_name: string;
  readonly link: string | null;
  readonly currency: 'USD';
  readonly balance_minor: number;
  readonly balance_on: string;
};

export type Payload = {
  readonly accounts: readonly PayloadAccount[];
  readonly transactions: readonly Omit<MonarchTransaction, 'tagged'>[];
  readonly balances: readonly MonarchBalance[];
};

/**
 * One asset's history (ACCT-06): the days Monarch's figure changed, not all 618 of them. A
 * value is carried forward until the next, in the chart and on the screen, so the days
 * between say nothing the change points do not; and the day a value was set is what its age
 * is counted from, which a copy on every day would reset to yesterday. The first is the
 * file's first day, 15 Jan 2025, not the day Monarch was first given it, which the file does
 * not say.
 */
export type AssetPayload = {
  readonly monarch_name: string;
  readonly kind: AssetKind;
  readonly values: readonly { readonly valued_on: string; readonly amount_minor: number }[];
};

export type Plan =
  | {
      readonly ok: true;
      readonly payloads: readonly Payload[];
      readonly assets: readonly AssetPayload[];
      readonly skipped: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * One payload per account, so each is its own transaction and a large account does not
 * carry the rest with it. Refused whole if the mapping is unconfirmed, or if the files name
 * an account the mapping does not: a new account in a later export is a question, not a
 * default.
 *
 * An account Monarch has transactions for and no balance at all is skipped, with its
 * reason: an account only Monarch knows takes its balance from Monarch's last day, and
 * without one it would be stored as zero.
 */
export function plan(
  mapping: Mapping,
  transactions: readonly MonarchTransaction[],
  balances: readonly MonarchBalance[],
): Plan {
  if (!mapping.confirmed) {
    return { ok: false, reason: 'the account mapping is not confirmed yet' };
  }
  const names = new Set([...transactions, ...balances].map((r) => r.account));
  const unmapped = [...names].filter((n) => !(n in mapping.accounts)).sort();
  if (unmapped.length > 0) {
    return { ok: false, reason: `the mapping does not say where ${unmapped.join(', ')} goes` };
  }

  const payloads: Payload[] = [];
  const assets: AssetPayload[] = [];
  const skipped: string[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const target = mapping.accounts[name];
    if (target === undefined || target === 'skip') continue;
    const days = balances.filter((b) => b.account === name);
    if (typeof target === 'object' && 'asset' in target) {
      const planned = planAsset(name, target.asset, days, transactions);
      if (planned.ok) {
        assets.push(planned.asset);
        if (planned.note !== null) skipped.push(planned.note);
      } else skipped.push(planned.reason);
      continue;
    }
    const last = days.reduce<MonarchBalance | undefined>(
      (newest, b) => (newest === undefined || b.on_date > newest.on_date ? b : newest),
      undefined,
    );
    const link = target === 'history' ? null : target.link;
    if (last === undefined && link === null) {
      skipped.push(`${name}: no balance in the file, so none to start it from`);
      continue;
    }
    payloads.push({
      accounts: [
        {
          monarch_name: name,
          link,
          currency: 'USD',
          balance_minor: last?.balance_minor ?? 0,
          balance_on: last?.on_date ?? '1970-01-01',
        },
      ],
      transactions: transactions
        .filter((t) => t.account === name)
        .map((t) => ({
          account: t.account,
          id: t.id,
          on_date: t.on_date,
          amount_minor: t.amount_minor,
          payee: t.payee,
          description: t.description,
          memo: t.memo,
          category: t.category,
        })),
      balances: days,
    });
  }
  return { ok: true, payloads, assets, skipped };
}

/**
 * An asset takes Monarch's balances as its values and nothing else. A transaction Monarch
 * put on one is left out and counted in `skipped`: Jewelry carries a single *Other Income*
 * on 28 Apr 2025 (counted 25 Sep), the day its value changed, and the change is already in
 * the balances. Refusing the asset for it, as the first cut did, left Jewelry out whole.
 */
function planAsset(
  name: string,
  kind: AssetKind,
  days: readonly MonarchBalance[],
  transactions: readonly MonarchTransaction[],
): { ok: true; asset: AssetPayload; note: string | null } | { ok: false; reason: string } {
  // A value is never negative (`asset_values_amount_nonnegative`); a debt is an account.
  if (days.some((d) => d.balance_minor < 0)) {
    return { ok: false, reason: `${name}: a value below zero, which no asset has` };
  }
  const values: { valued_on: string; amount_minor: number }[] = [];
  for (const d of days.toSorted((a, b) => a.on_date.localeCompare(b.on_date))) {
    if (values.at(-1)?.amount_minor === d.balance_minor) continue;
    values.push({ valued_on: d.on_date, amount_minor: d.balance_minor });
  }
  if (values.length === 0) {
    return { ok: false, reason: `${name}: no value in the file, so nothing to bring in` };
  }
  const left = transactions.filter((t) => t.account === name).length;
  return {
    ok: true,
    asset: { monarch_name: name, kind, values },
    note:
      left === 0
        ? null
        : `${name}: ${left} transaction(s) left out, since an asset keeps values, not transactions`,
  };
}

/* ─── what an import says ───────────────────────────────────────────────────────────────── */

export const storedSchema = z.object({
  accounts_added: z.int(),
  accounts_changed: z.int(),
  transactions_added: z.int(),
  transactions_changed: z.int(),
  transactions_left_to_bank: z.int(),
  days_added: z.int(),
  days_changed: z.int(),
  days_left_to_bank: z.int(),
  days_matched: z.int(),
  days_differed: z.int(),
});

export type Stored = z.output<typeof storedSchema>;

export function parseStored(input: unknown) {
  return parse(storedSchema, input);
}

export const NOTHING_STORED: Stored = {
  accounts_added: 0,
  accounts_changed: 0,
  transactions_added: 0,
  transactions_changed: 0,
  transactions_left_to_bank: 0,
  days_added: 0,
  days_changed: 0,
  days_left_to_bank: 0,
  days_matched: 0,
  days_differed: 0,
};

/** Two accounts' counts as one import's. */
export function addStored(a: Stored, b: Stored): Stored {
  return {
    accounts_added: a.accounts_added + b.accounts_added,
    accounts_changed: a.accounts_changed + b.accounts_changed,
    transactions_added: a.transactions_added + b.transactions_added,
    transactions_changed: a.transactions_changed + b.transactions_changed,
    transactions_left_to_bank: a.transactions_left_to_bank + b.transactions_left_to_bank,
    days_added: a.days_added + b.days_added,
    days_changed: a.days_changed + b.days_changed,
    days_left_to_bank: a.days_left_to_bank + b.days_left_to_bank,
    days_matched: a.days_matched + b.days_matched,
    days_differed: a.days_differed + b.days_differed,
  };
}

/** Nothing added and nothing changed: what a second import of the same files must say. */
export function wroteNothing(s: Stored): boolean {
  return (
    s.accounts_added +
      s.accounts_changed +
      s.transactions_added +
      s.transactions_changed +
      s.days_added +
      s.days_changed ===
    0
  );
}
