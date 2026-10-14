import type {
  Amount,
  BudgetRow,
  CategoryRow,
  Entry,
  Filer,
  Month,
  SpendLine,
  TransactionRow,
} from './budgets.ts';
import { entriesIn, lastDayOf, monthOf, shiftMonth, spentShare, summarise } from './budgets.ts';
import type { RateRow } from './rates.ts';

/*
 * A month read by what needs looking at (UI-11). The budget page was every category in the order
 * of what it had spent, each the same bar, so a category over its budget looked like one with
 * none, and 60% spent on the 10th drew the same bar as on the 28th. Nora, 26 Sep: "it feels like
 * everything is one big list and I have to look over everything to find it."
 *
 * So each budgeted category is placed against how far through the month today is: over its
 * budget, ahead of the month's pace, or on track, and the page lists them in that order.
 */

/** How far through a month a day is. */
export type MonthClock = {
  /** Tenths of a percent of the month gone, today included: 1000 once it is over. */
  readonly elapsed: number;
  /** Days after today to the month's end; 0 once it is over. */
  readonly daysLeft: number;
  /** Today is in it, so there is a pace to be ahead of. */
  readonly running: boolean;
};

export function monthClock(month: Month, today: string): MonthClock {
  const days = Number(lastDayOf(month).slice(8));
  const current = monthOf(today);
  if (month < current) return { elapsed: 1000, daysLeft: 0, running: false };
  if (month > current) return { elapsed: 0, daysLeft: days, running: false };
  const day = Number(today.slice(8, 10));
  return { elapsed: Math.floor((day * 1000) / days), daysLeft: days - day, running: true };
}

/**
 * Over: spent more than the budget. Ahead: a larger share of the budget spent than of the month
 * gone, which only a running month can be. On track: neither.
 */
export type Standing = 'over' | 'ahead' | 'on-track';

export function standingOf(spentMinor: bigint, budgetMinor: bigint, clock: MonthClock): Standing {
  if (spentMinor > budgetMinor) return 'over';
  const share = spentShare(spentMinor, budgetMinor);
  return clock.running && share !== null && share > clock.elapsed ? 'ahead' : 'on-track';
}

export type Placed = {
  readonly line: SpendLine;
  /** Null when the spending or the budget could not be worked out: no rate for a currency. */
  readonly standing: Standing | null;
  /** Tenths of a percent of the budget spent, as `spentShare`; null when not worked out. */
  readonly share: number | null;
};

export type Attention = {
  /** Most over first. */
  readonly over: readonly Placed[];
  /** Furthest ahead first. */
  readonly ahead: readonly Placed[];
  /** Closest to the budget first; those not worked out last. */
  readonly onTrack: readonly Placed[];
  /** Spending categories with no budget this month, most spent first. */
  readonly unbudgeted: readonly SpendLine[];
};

export function byAttention(lines: readonly SpendLine[], clock: MonthClock): Attention {
  const over: Placed[] = [];
  const ahead: Placed[] = [];
  const onTrack: Placed[] = [];
  const unbudgeted: SpendLine[] = [];
  for (const line of lines) {
    if (line.budget === null) {
      unbudgeted.push(line);
      continue;
    }
    if (line.budgetMinor === null || line.spent.kind !== 'summed') {
      onTrack.push({ line, standing: null, share: null });
      continue;
    }
    const standing = standingOf(line.spent.minor, line.budgetMinor, clock);
    const placed = { line, standing, share: spentShare(line.spent.minor, line.budgetMinor) };
    (standing === 'over' ? over : standing === 'ahead' ? ahead : onTrack).push(placed);
  }
  const overBy = (p: Placed) =>
    p.line.spent.kind === 'summed' && p.line.budgetMinor !== null
      ? p.line.spent.minor - p.line.budgetMinor
      : 0n;
  over.sort((a, b) => compareBig(overBy(b), overBy(a)) || byName(a, b));
  const byShare = (a: Placed, b: Placed) => (b.share ?? -1) - (a.share ?? -1) || byName(a, b);
  ahead.sort(byShare);
  onTrack.sort(byShare);
  // `summarise` gives them most spent first already, which is the order wanted.
  return { over, ahead, onTrack, unbudgeted };
}

function compareBig(a: bigint, b: bigint): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function byName(a: Placed, b: Placed): number {
  return a.line.category.name.localeCompare(b.line.category.name);
}

/* ─── what a category spent before ──────────────────────────────────────────────────────── */

export type PastMonth = { readonly month: Month; readonly spent: Amount };

/** What a month's page needs to work out another month's spending. */
export type History = {
  readonly transactions: readonly TransactionRow[];
  /** The accounts that count, to their currencies, as `entriesIn`. */
  readonly counted: ReadonlyMap<string, string>;
  readonly file: Filer;
  readonly categories: readonly CategoryRow[];
  readonly budgets: readonly BudgetRow[];
  readonly rates: readonly RateRow[];
  readonly today: string;
};

/**
 * What a spending category spent in each of the `count` months before `month`, the nearest
 * first: what setting its budget is weighed against. Each month is summed as its own page sums
 * it, at its own rates, so the figure offered is the one that month's page shows.
 */
export function spentBefore(
  categoryId: string,
  month: Month,
  count: number,
  history: History,
): PastMonth[] {
  const past: PastMonth[] = [];
  for (let back = 1; back <= count; back += 1) {
    const m = shiftMonth(month, -back);
    const entries = entriesIn(
      m,
      history.transactions,
      history.counted,
      history.file,
      history.today,
    );
    const summary = summarise(
      m,
      entries,
      history.categories,
      history.budgets,
      history.rates,
      history.today,
    );
    const line = summary.spend.find((l) => l.category.id === categoryId);
    past.push({ month: m, spent: line === undefined ? { kind: 'summed', minor: 0n } : line.spent });
  }
  return past;
}

/**
 * Their average, rounded to the nearest minor unit, and never below nothing: a month of refunds
 * is no budget to suggest. Null when any month could not be worked out, or there are none.
 */
export function averageSpent(past: readonly PastMonth[]): bigint | null {
  if (past.length === 0) return null;
  let sum = 0n;
  for (const month of past) {
    if (month.spent.kind !== 'summed') return null;
    sum += month.spent.minor > 0n ? month.spent.minor : 0n;
  }
  const n = BigInt(past.length);
  return (sum * 2n + n) / (2n * n);
}

/* ─── which categories hold anything ────────────────────────────────────────────────────── */

/**
 * The categories any live transaction is filed under, in any month and any account. Nora, 26 Sep:
 * a category nothing is filed under should sink to the bottom of the list.
 */
export function categoriesInUse(transactions: readonly TransactionRow[], file: Filer): Set<string> {
  const used = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.deleted_at !== null) continue;
    const filed = file(transaction);
    if (filed.kind !== 'none') used.add(filed.category.id);
  }
  return used;
}

/* ─── the month as a line ───────────────────────────────────────────────────────────────── */

/*
 * Spending by day against an even pace to the budget (BUD-02). A bar cannot say whether a month
 * is on track: 60% spent on the 10th and on the 28th draw the same bar. A line of what had been
 * spent by each day, beside a straight line from nothing to the budget, says it at a glance.
 */

/**
 * What the month's total read at the end of each day: index 0 is its start, at nothing, and
 * index n the end of day n, as far as today in a running month. Null where a currency had no
 * rate.
 *
 * Each day is `summarise` over the entries up to it, rather than a running sum of daily totals,
 * because the month's figure rounds once per currency per category and a sum of days rounds once
 * per day: over euro spending the line's end would miss the figure above it by cents.
 */
export function spentByDay(
  month: Month,
  entries: readonly Entry[],
  categories: readonly CategoryRow[],
  rates: readonly RateRow[],
  today: string,
): (bigint | null)[] {
  const days = Number(lastDayOf(month).slice(8));
  const clock = monthClock(month, today);
  const through = clock.running ? days - clock.daysLeft : clock.elapsed === 0 ? 0 : days;
  const line: (bigint | null)[] = [0n];
  for (let n = 1; n <= through; n += 1) {
    const day = `${month}-${String(n).padStart(2, '0')}`;
    const upTo = entries.filter((entry) => entry.day <= day);
    line.push(summarise(month, upTo, categories, [], rates, today).spentMinor);
  }
  return line;
}

/**
 * Another month's line laid along one `days` long, by day of the month: a longer month's last
 * days fold into this one's end, and a shorter month holds its total past its own. Either way
 * the line ends at what that month spent.
 */
export function laidAlong(line: readonly (bigint | null)[], days: number): (bigint | null)[] {
  const last = line.length - 1;
  const laid: (bigint | null)[] = [];
  for (let n = 0; n <= days; n += 1) {
    laid.push(line[n === days ? last : Math.min(n, last)] ?? null);
  }
  return laid;
}

/** An even pace's figure at the end of `day`, to the nearest minor unit. */
export function evenPace(budgetMinor: bigint, day: number, days: number): bigint {
  const d = BigInt(days);
  return (budgetMinor * BigInt(day) * 2n + d) / (2n * d);
}
