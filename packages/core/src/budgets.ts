import { z } from 'zod';

import type { Total } from './balances.ts';
import type { Conversion } from './rates.ts';
import { NET_CURRENCY, sumIn } from './rates.ts';
import type { RateRow } from './rates.ts';
import type { Pairs } from './transfers.ts';

/**
 * Budgets (BUD-01): transactions put into categories of hers, a monthly budget for each, and
 * how a month is going against it.
 *
 * Decided on the runway before this was written: the categories are Dinora's own, not the
 * aggregator's, with the aggregator's kept as the first guess; and a rule that re-categorises a
 * payee applies forward and is shown, never silently rewriting past months.
 *
 * Nothing here rewrites a transaction, which stays the bank's. Where one is filed is worked out
 * on the device each time, in this order (`makeFiler`):
 *
 *   1. her own choice for that transaction;
 *   2. else the newest rule for its payee that had started by the transaction's day;
 *   3. else, when it is one side of a transfer between her accounts (`pairTransfers`), a
 *      transfer category, with the other side;
 *   4. else the aggregator's category, when a category of hers takes guesses from that name;
 *   5. else nowhere, shown as unsorted.
 *
 * Only Monarch's history carries an aggregator's category (`source_category`, ACCT-05, and
 * Plaid's through it); SimpleFIN sends none. So a new card transaction is unsorted until she
 * sorts it or a rule does, and the page says how many are.
 */

export const CATEGORY_KINDS = ['spend', 'income', 'transfer'] as const;

export type CategoryKind = (typeof CATEGORY_KINDS)[number];

const day = z.iso.date();
const stamp = z.iso.datetime({ offset: true });

export const categoryRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  name: z.string().min(1),
  kind: z.enum(CATEGORY_KINDS),
  guesses_from: z.array(z.string()),
  created_at: stamp,
});

export type CategoryRow = z.output<typeof categoryRowSchema>;

export const budgetRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  category_id: z.string(),
  starts_on: day,
  // `z.int()` is a safe integer: past 2^53 a bigint column would arrive already rounded.
  amount_minor: z.int().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export type BudgetRow = z.output<typeof budgetRowSchema>;

/** Her choice for one transaction (`transaction_categories`). */
export const choiceRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  transaction_id: z.string(),
  category_id: z.string(),
});

export type ChoiceRow = z.output<typeof choiceRowSchema>;

export const ruleRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  payee: z.string().min(1),
  /** Null: the rule stopped from `starts_on`. */
  category_id: z.string().nullable(),
  starts_on: day,
  created_at: stamp,
});

export type RuleRow = z.output<typeof ruleRowSchema>;

/** A transaction as the device keeps it: what sorting and totalling one needs, no more. */
export const transactionRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  account_id: z.string(),
  posted_at: stamp.nullable(),
  transacted_at: stamp.nullable(),
  amount_minor: z.int(),
  payee: z.string().nullable(),
  description: z.string(),
  source_category: z.string().nullable(),
  pending: z.boolean(),
});

export type TransactionRow = z.output<typeof transactionRowSchema>;

/** In the order she made them, so a guess two categories both claim goes to the older. */
export function compareCategories(a: CategoryRow, b: CategoryRow): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id);
}

export function compareBudgets(a: BudgetRow, b: BudgetRow): number {
  return a.category_id.localeCompare(b.category_id) || a.starts_on.localeCompare(b.starts_on);
}

export function compareChoices(a: ChoiceRow, b: ChoiceRow): number {
  return a.transaction_id.localeCompare(b.transaction_id) || a.id.localeCompare(b.id);
}

export function compareRules(a: RuleRow, b: RuleRow): number {
  return a.payee.localeCompare(b.payee) || a.starts_on.localeCompare(b.starts_on);
}

/** Newest first, as a month's list reads. */
export function compareTransactions(a: TransactionRow, b: TransactionRow): number {
  const on = (t: TransactionRow) => t.transacted_at ?? t.posted_at ?? '';
  return on(b).localeCompare(on(a)) || a.id.localeCompare(b.id);
}

/* ─── months and days ───────────────────────────────────────────────────────────────────── */

/** `2026-09`. A month is its first day's first seven characters, so it sorts as text. */
export type Month = string;

export function monthOf(isoDate: string): Month {
  return isoDate.slice(0, 7);
}

export function firstDayOf(month: Month): string {
  return `${month}-01`;
}

export function shiftMonth(month: Month, by: number): Month {
  const [year = 0, number = 1] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + by;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The last day of the month, `2026-02-28`. */
export function lastDayOf(month: Month): string {
  const next = Date.parse(`${firstDayOf(shiftMonth(month, 1))}T00:00:00Z`);
  return new Date(next - 86_400_000).toISOString().slice(0, 10);
}

/** "September 2026". */
export function describeMonth(month: Month, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.parse(`${firstDayOf(month)}T00:00:00Z`));
}

/**
 * The day a transaction counts on: when it was made if the bank says, else when it posted,
 * else — pending and undated — today. Its UTC day, as `balance_snapshots` rebuilds history
 * (ACCT-03), so a transaction is in the same month on the budget as in the history.
 */
export function dayOf(transaction: TransactionRow, today: string): string {
  const at = transaction.transacted_at ?? transaction.posted_at;
  return at === null ? today : new Date(Date.parse(at)).toISOString().slice(0, 10);
}

/* ─── where a transaction is filed ──────────────────────────────────────────────────────── */

/** Trimmed, lower case, one space between words: `Whole  Foods ` and `whole foods` are one. */
export function normalisePayee(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The payee a rule matches: the bank's payee, or its description when it sends none. */
export function payeeOf(transaction: TransactionRow): string {
  return normalisePayee(transaction.payee ?? transaction.description);
}

/** What she sees for the payee: the bank's words, not the key. */
export function payeeName(transaction: TransactionRow): string {
  const text = (transaction.payee ?? transaction.description).trim();
  return text === '' ? 'No payee' : text;
}

export type Filed =
  | { readonly kind: 'chosen'; readonly category: CategoryRow; readonly choice: ChoiceRow }
  | { readonly kind: 'rule'; readonly category: CategoryRow; readonly rule: RuleRow }
  | { readonly kind: 'paired'; readonly category: CategoryRow; readonly partner: TransactionRow }
  | { readonly kind: 'guess'; readonly category: CategoryRow; readonly from: string }
  | { readonly kind: 'none' };

export type Filer = (transaction: TransactionRow) => Filed;

/**
 * Files transactions against her rows, indexed once so a month of them is filed in one pass.
 *
 * A choice or rule pointing at a category she has removed files nothing and falls through to
 * the next step, rather than to a category the page no longer lists. A rule applies from its
 * `starts_on` (never before), and the newest to have started governs: a stopped rule (no
 * category) hands the payee back to the guess from its month on, leaving the months before it
 * as they were.
 *
 * A pair (BUD-05) comes after her choice and her rules, which are hers, and before the guess,
 * which is Monarch's: a side guessed as spending is the double count pairing exists to stop.
 * Both sides are filed together. When she filed the other side under a transfer category,
 * choice or rule, this side goes there too; when she filed it anywhere else, she has said it is
 * no transfer, and this side is filed as if it had no pair. Otherwise the pair goes where
 * either side's guess puts it when that is a transfer category, else to her oldest. With no
 * transfer category at all, there is nowhere to file it, and it is not paired.
 */
export function makeFiler(
  categories: readonly CategoryRow[],
  choices: readonly ChoiceRow[],
  rules: readonly RuleRow[],
  today: string,
  pairs: Pairs = new Map(),
): Filer {
  const live = new Map(
    categories.filter((c) => c.deleted_at === null).map((c) => [c.id, c] as const),
  );
  const chosen = new Map<string, ChoiceRow>();
  for (const choice of choices) {
    if (choice.deleted_at === null) chosen.set(choice.transaction_id, choice);
  }
  const byPayee = new Map<string, RuleRow[]>();
  for (const rule of rules) {
    if (rule.deleted_at !== null) continue;
    byPayee.set(rule.payee, [...(byPayee.get(rule.payee) ?? []), rule]);
  }
  for (const list of byPayee.values()) list.sort(newestRuleFirst);
  const guesses = new Map<string, CategoryRow>();
  for (const category of [...live.values()].sort(compareCategories)) {
    for (const name of category.guesses_from) {
      if (!guesses.has(name)) guesses.set(name, category);
    }
  }

  const firstTransfer = [...live.values()]
    .sort(compareCategories)
    .find((c) => c.kind === 'transfer');

  const hers = (transaction: TransactionRow): Filed | undefined => {
    const choice = chosen.get(transaction.id);
    const mine = choice === undefined ? undefined : live.get(choice.category_id);
    if (choice !== undefined && mine !== undefined) {
      return { kind: 'chosen', category: mine, choice };
    }
    const on = dayOf(transaction, today);
    const rule = byPayee.get(payeeOf(transaction))?.find((r) => r.starts_on <= on);
    const ruledId = rule?.category_id ?? null;
    const ruled = ruledId === null ? undefined : live.get(ruledId);
    if (rule !== undefined && ruled !== undefined) {
      return { kind: 'rule', category: ruled, rule };
    }
    return undefined;
  };
  const guessOf = (transaction: TransactionRow): Filed | undefined => {
    const from = transaction.source_category;
    const guessed = from === null ? undefined : guesses.get(from);
    return from === null || guessed === undefined
      ? undefined
      : { kind: 'guess', category: guessed, from };
  };
  const transferIn = (filed: Filed | undefined): CategoryRow | undefined =>
    filed !== undefined && filed.kind !== 'none' && filed.category.kind === 'transfer'
      ? filed.category
      : undefined;

  return (transaction) => {
    const mine = hers(transaction);
    if (mine !== undefined) return mine;
    const partner = pairs.get(transaction.id);
    const theirs = partner === undefined ? undefined : hers(partner);
    if (partner !== undefined && (theirs === undefined || transferIn(theirs) !== undefined)) {
      const category =
        transferIn(theirs) ??
        transferIn(guessOf(transaction)) ??
        transferIn(guessOf(partner)) ??
        firstTransfer;
      if (category !== undefined) return { kind: 'paired', category, partner };
    }
    return guessOf(transaction) ?? { kind: 'none' };
  };
}

function newestRuleFirst(a: RuleRow, b: RuleRow): number {
  return (
    b.starts_on.localeCompare(a.starts_on) ||
    Date.parse(b.created_at) - Date.parse(a.created_at) ||
    b.id.localeCompare(a.id)
  );
}

/**
 * The rules in force in a month, one per payee: the newest to have started by its first day,
 * or by its last for a rule made that month. A stopped rule is not listed.
 */
export function rulesIn(month: Month, rules: readonly RuleRow[]): RuleRow[] {
  const end = lastDayOf(month);
  const governing = new Map<string, RuleRow>();
  for (const rule of [...rules].sort(newestRuleFirst)) {
    if (rule.deleted_at !== null || rule.starts_on > end || governing.has(rule.payee)) continue;
    governing.set(rule.payee, rule);
  }
  return [...governing.values()]
    .filter((rule) => rule.category_id !== null)
    .sort((a, b) => a.payee.localeCompare(b.payee));
}

/* ─── the aggregator's categories, as a start ───────────────────────────────────────────── */

/**
 * Monarch's own groups, read off its default category list: *Income* holds Paychecks,
 * Interest, Business Income and Other Income; *Transfers* holds Transfer, Credit Card Payment
 * and Balance Adjustments. Everything else it calls an expense. A guess from names, which she
 * can change on the page; not measured against her export.
 */
export function guessKind(name: string): CategoryKind {
  if (/transfer|credit card payment|balance adjustment/i.test(name)) return 'transfer';
  if (/paycheck|income|interest|dividend/i.test(name)) return 'income';
  return 'spend';
}

export type Unclaimed = {
  readonly name: string;
  /** Live transactions carrying it. */
  readonly count: number;
  readonly kind: CategoryKind;
  /** A live category of hers with this name, which it could be added to instead. */
  readonly sameName: CategoryRow | null;
};

/**
 * The aggregator's categories no category of hers takes guesses from, most used first. The
 * page offers them as a start — one category each — and in a category's form, to add.
 */
export function unclaimedSources(
  transactions: readonly TransactionRow[],
  categories: readonly CategoryRow[],
): Unclaimed[] {
  const live = categories.filter((c) => c.deleted_at === null);
  const claimed = new Set(live.flatMap((c) => c.guesses_from));
  const counts = new Map<string, number>();
  for (const t of transactions) {
    const name = t.source_category;
    if (t.deleted_at !== null || name === null || name.trim() === '' || claimed.has(name)) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({
      name,
      count,
      kind: guessKind(name),
      sameName: live.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type Starting = {
  readonly name: string;
  readonly kind: CategoryKind;
  readonly guessesFrom: readonly string[];
};

/**
 * The categories a first start makes from the unclaimed names: one per name, except that names
 * differing only in case become one category taking guesses from each (two live categories
 * cannot share a name, `categories_live_name_key`). A name that is already a category's, or too
 * long to be one, is left for her to add by hand.
 */
export function startingCategories(unclaimed: readonly Unclaimed[]): Starting[] {
  const byName = new Map<string, { name: string; kind: CategoryKind; guessesFrom: string[] }>();
  for (const source of unclaimed) {
    const name = source.name.trim();
    if (source.sameName !== null || name.length > 100) continue;
    const key = name.toLowerCase();
    const held = byName.get(key);
    if (held === undefined)
      byName.set(key, { name, kind: source.kind, guessesFrom: [source.name] });
    else held.guessesFrom.push(source.name);
  }
  return [...byName.values()];
}

/* ─── a budget ──────────────────────────────────────────────────────────────────────────── */

export type Budget = {
  readonly row: BudgetRow;
  readonly amountMinor: number;
};

/**
 * A category's budget for a month: the newest row starting on or before it. None when there is
 * no row, or when the newest says none from then on.
 */
export function budgetFor(
  categoryId: string,
  month: Month,
  budgets: readonly BudgetRow[],
): Budget | null {
  const first = firstDayOf(month);
  let newest: BudgetRow | null = null;
  for (const row of budgets) {
    if (row.deleted_at !== null || row.category_id !== categoryId || row.starts_on > first) {
      continue;
    }
    if (newest === null || row.starts_on > newest.starts_on) newest = row;
  }
  return newest === null || newest.amount_minor === null
    ? null
    : { row: newest, amountMinor: newest.amount_minor };
}

/** The live row that starts in exactly this month, which a change from this month edits. */
export function budgetRowIn(
  categoryId: string,
  month: Month,
  budgets: readonly BudgetRow[],
): BudgetRow | null {
  const first = firstDayOf(month);
  return (
    budgets.find(
      (row) => row.deleted_at === null && row.category_id === categoryId && row.starts_on === first,
    ) ?? null
  );
}

/* ─── a month ───────────────────────────────────────────────────────────────────────────── */

export type Entry = {
  readonly transaction: TransactionRow;
  /** Its account's. */
  readonly currency: string;
  readonly day: string;
  readonly filed: Filed;
};

/**
 * A month's transactions in the accounts that count, newest first, each with where it is
 * filed. `counted` maps each such account to its currency: the page counts cash and cards, not
 * investment accounts, whose buys and sells are not spending.
 */
export function entriesIn(
  month: Month,
  transactions: readonly TransactionRow[],
  counted: ReadonlyMap<string, string>,
  file: Filer,
  today: string,
): Entry[] {
  const entries: Entry[] = [];
  for (const transaction of transactions) {
    const currency = counted.get(transaction.account_id);
    if (transaction.deleted_at !== null || currency === undefined) continue;
    const on = dayOf(transaction, today);
    if (monthOf(on) !== month) continue;
    entries.push({ transaction, currency, day: on, filed: file(transaction) });
  }
  return entries.sort(
    (a, b) => b.day.localeCompare(a.day) || compareTransactions(a.transaction, b.transaction),
  );
}

/** An amount summed across currencies, or unsaid when one has no rate (as `sumIn`). */
export type Amount =
  | { readonly kind: 'summed'; readonly minor: bigint }
  | { readonly kind: 'unrated'; readonly missing: readonly string[] };

export type SpendLine = {
  readonly category: CategoryRow;
  readonly count: number;
  /** Money out, net of refunds: positive when more left than came back. */
  readonly spent: Amount;
  readonly budget: Budget | null;
  /** The budget in the month's currency; null with no budget, or no rate for it. */
  readonly budgetMinor: bigint | null;
};

export type OtherLine = {
  readonly category: CategoryRow;
  readonly count: number;
  /** As the bank signs it: money in is positive. */
  readonly net: Amount;
};

export type MonthSummary = {
  readonly month: Month;
  readonly currency: string;
  /** The day whose rates converted anything not in `currency`: the month's last, or today. */
  readonly ratesOn: string;
  /** Spending categories with a budget or a transaction this month, most spent first. */
  readonly spend: readonly SpendLine[];
  readonly income: readonly OtherLine[];
  readonly transfers: readonly OtherLine[];
  readonly unsorted: { readonly count: number; readonly net: Amount };
  readonly spentMinor: bigint | null;
  readonly budgetedMinor: bigint | null;
  readonly incomeMinor: bigint | null;
  /** Each currency converted, with the stored rate it used (invariant 3). */
  readonly conversions: readonly Conversion[];
};

type Bucket = { count: number; totals: Map<string, bigint> };

function totalsOf(bucket: Bucket | undefined): Total[] {
  return [...(bucket?.totals ?? [])].map(([currency, minor]) => ({ currency, minor, accounts: 0 }));
}

/**
 * How a month went, in `currency`. Each category's transactions are summed per currency and
 * converted at one rate per currency — the one the month's last day had, or today's while the
 * month is running — so a past month reads the same next year (invariant 3), and there is one
 * rounding per currency per category, never one per transaction.
 */
export function summarise(
  month: Month,
  entries: readonly Entry[],
  categories: readonly CategoryRow[],
  budgets: readonly BudgetRow[],
  rates: readonly RateRow[],
  today: string,
  currency: string = NET_CURRENCY,
): MonthSummary {
  const last = lastDayOf(month);
  const ratesOn = today < last ? today : last;
  const buckets = new Map<string, Bucket>();
  const unsortedKey = '';
  for (const entry of entries) {
    const key = entry.filed.kind === 'none' ? unsortedKey : entry.filed.category.id;
    const bucket = buckets.get(key) ?? { count: 0, totals: new Map<string, bigint>() };
    bucket.count += 1;
    bucket.totals.set(
      entry.currency,
      (bucket.totals.get(entry.currency) ?? 0n) + BigInt(entry.transaction.amount_minor),
    );
    buckets.set(key, bucket);
  }

  const conversions = new Map<string, Conversion>();
  const amount = (totals: readonly Total[]): Amount => {
    const sum = sumIn(totals, rates, currency, ratesOn);
    if (sum.kind === 'unrated') return { kind: 'unrated', missing: sum.missing };
    for (const c of sum.conversions) conversions.set(`${c.currency}:${c.rate.id}`, c);
    return { kind: 'summed', minor: sum.minor };
  };

  const live = categories.filter((c) => c.deleted_at === null);
  const spend: SpendLine[] = [];
  const income: OtherLine[] = [];
  const transfers: OtherLine[] = [];
  for (const category of live) {
    const bucket = buckets.get(category.id);
    const count = bucket?.count ?? 0;
    if (category.kind !== 'spend') {
      if (count === 0) continue;
      const line = { category, count, net: amount(totalsOf(bucket)) };
      (category.kind === 'income' ? income : transfers).push(line);
      continue;
    }
    const budget = budgetFor(category.id, month, budgets);
    if (count === 0 && budget === null) continue;
    const net = amount(totalsOf(bucket));
    const spent: Amount = net.kind === 'summed' ? { kind: 'summed', minor: -net.minor } : net;
    const inBudget =
      budget === null
        ? null
        : amount([
            { currency: budget.row.currency, minor: BigInt(budget.amountMinor), accounts: 0 },
          ]);
    spend.push({
      category,
      count,
      spent,
      budget,
      budgetMinor: inBudget?.kind === 'summed' ? inBudget.minor : null,
    });
  }

  const minorOf = (a: Amount) => (a.kind === 'summed' ? a.minor : null);
  const byName = (a: { category: CategoryRow }, b: { category: CategoryRow }) =>
    a.category.name.localeCompare(b.category.name);
  spend.sort((a, b) => {
    const x = minorOf(a.spent) ?? 0n;
    const y = minorOf(b.spent) ?? 0n;
    return x === y ? byName(a, b) : x > y ? -1 : 1;
  });
  income.sort(byName);
  transfers.sort(byName);

  const unsortedBucket = buckets.get(unsortedKey);
  const sumOf = (values: readonly (bigint | null)[]) =>
    values.some((v) => v === null) ? null : values.reduce<bigint>((a, v) => a + (v ?? 0n), 0n);

  return {
    month,
    currency,
    ratesOn,
    spend,
    income,
    transfers,
    unsorted: { count: unsortedBucket?.count ?? 0, net: amount(totalsOf(unsortedBucket)) },
    spentMinor: sumOf(spend.map((line) => minorOf(line.spent))),
    budgetedMinor: sumOf(
      spend.filter((line) => line.budget !== null).map((line) => line.budgetMinor),
    ),
    incomeMinor: sumOf(income.map((line) => minorOf(line.net))),
    conversions: [...conversions.values()],
  };
}

/** Tenths of a percent of a budget spent, from 0; above 1000 once over. Null for no budget. */
export function spentShare(spentMinor: bigint, budgetMinor: bigint): number | null {
  if (budgetMinor <= 0n) return null;
  return spentMinor <= 0n ? 0 : Number((spentMinor * 1000n) / budgetMinor);
}
