import type { Total } from './balances.ts';
import type { Amount, Entry, Month } from './budgets.ts';
import { lastDayOf } from './budgets.ts';
import type { Conversion, RateRow } from './rates.ts';
import { NET_CURRENCY, sumIn } from './rates.ts';

/**
 * A month as a grid of days, each shaded by what was spent on it (BUD-03).
 *
 * What a day spent is what the month's total counts, taken a day at a time: transactions filed
 * in a spending category, net of refunds. Income, transfers and anything unsorted are on the
 * day's list but not in its shade, as they are not in the month's total.
 */

/** 0 for a day that spent nothing, else 1 to 4, quieter to busier. */
export type Shade = 0 | 1 | 2 | 3 | 4;

export type CalendarDay = {
  readonly day: string;
  /** Money out on spending categories, net of refunds; zero on a day with none. */
  readonly spent: Amount;
  /** The day's entries, every kind: what tapping the day lists. */
  readonly entries: readonly Entry[];
  /**
   * Entries with no category. They are left out of `spent`, so a day holding one reads quieter
   * than what left the account; the grid marks it rather than let the shade pass for the whole
   * day (Nora, 26 Sep).
   */
  readonly uncategorized: number;
  /** After today, in the month still running: nothing to show yet. */
  readonly ahead: boolean;
  readonly shade: Shade;
};

export type Calendar = {
  readonly month: Month;
  readonly currency: string;
  /** Monday first; `null` pads the first and last weeks out to seven. */
  readonly weeks: readonly (readonly (CalendarDay | null)[])[];
  /** Each currency converted, with the stored rate it used (invariant 3). */
  readonly conversions: readonly Conversion[];
};

/**
 * Monday first, so Saturday and Sunday sit together at the end of each row. The weekend habit
 * is what a calendar shows that the category list does not (the audit, 26 Sep), and a Sunday
 * first splits it across the grid's two edges.
 */
export const WEEKDAYS = 7;

/**
 * The month's days from its entries. Each day's currencies are converted at the rate the month
 * summary uses (the month's last day, or today while it runs), so a past month's days read the
 * same next year; one rounding per currency per day.
 */
export function calendarOf(
  month: Month,
  entries: readonly Entry[],
  rates: readonly RateRow[],
  today: string,
  currency: string = NET_CURRENCY,
): Calendar {
  const last = lastDayOf(month);
  const ratesOn = today < last ? today : last;
  const byDay = new Map<string, Entry[]>();
  for (const entry of entries) {
    byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), entry]);
  }

  const conversions = new Map<string, Conversion>();
  const days: Omit<CalendarDay, 'shade'>[] = [];
  const count = Number(last.slice(8, 10));
  for (let n = 1; n <= count; n += 1) {
    const day = `${month}-${String(n).padStart(2, '0')}`;
    const onDay = byDay.get(day) ?? [];
    const totals = new Map<string, bigint>();
    for (const entry of onDay) {
      if (entry.filed.kind === 'none' || entry.filed.category.kind !== 'spend') continue;
      const minor = BigInt(entry.transaction.amount_minor);
      totals.set(entry.currency, (totals.get(entry.currency) ?? 0n) + minor);
    }
    const list: Total[] = [...totals].map(([c, minor]) => ({ currency: c, minor, accounts: 0 }));
    const sum = sumIn(list, rates, currency, ratesOn);
    let spent: Amount;
    if (sum.kind === 'unrated') spent = { kind: 'unrated', missing: sum.missing };
    else {
      for (const c of sum.conversions) conversions.set(`${c.currency}:${c.rate.id}`, c);
      spent = { kind: 'summed', minor: -sum.minor };
    }
    const uncategorized = onDay.filter((entry) => entry.filed.kind === 'none').length;
    days.push({ day, spent, entries: onDay, uncategorized, ahead: day > today });
  }

  const shade = shader(days.map((d) => d.spent));
  const shaded = days.map((d) => ({ ...d, shade: shade(d.spent) }));
  const lead = weekdayOf(shaded[0]?.day ?? `${month}-01`);
  const cells: (CalendarDay | null)[] = [...Array<null>(lead).fill(null), ...shaded];
  while (cells.length % WEEKDAYS !== 0) cells.push(null);
  const weeks: (CalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += WEEKDAYS) weeks.push(cells.slice(i, i + WEEKDAYS));

  return { month, currency, weeks, conversions: [...conversions.values()] };
}

/** 0 for Monday to 6 for Sunday. */
export function weekdayOf(isoDate: string): number {
  return (new Date(Date.parse(`${isoDate}T00:00:00Z`)).getUTCDay() + 6) % WEEKDAYS;
}

/**
 * Shades by rank among the month's spending days, in quarters: a day is as dark as the share of
 * the month's spending days that spent no more than it. By rank, not by amount, because one rent
 * or airfare day would otherwise leave every other day the palest step and the grid saying
 * nothing. The price is that shade says how a day ranks in its month, not what it cost, so
 * every cell's label carries its amount.
 */
function shader(spent: readonly Amount[]): (amount: Amount) => Shade {
  const sorted = spent
    .flatMap((a) => (a.kind === 'summed' && a.minor > 0n ? [a.minor] : []))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (amount) => {
    if (amount.kind !== 'summed' || amount.minor <= 0n) return 0;
    const atOrBelow = sorted.filter((minor) => minor <= amount.minor).length;
    const quarter = Math.ceil((4 * atOrBelow) / sorted.length);
    return quarter <= 1 ? 1 : quarter === 2 ? 2 : quarter === 3 ? 3 : 4;
  };
}
