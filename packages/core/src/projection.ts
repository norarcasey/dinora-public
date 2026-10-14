import type { AccountRow } from './balances.ts';
import type { GoalAccountRow, GoalRow, Progress } from './goals.ts';
import { accountsOf, balanceOn, firstCommonDay } from './goals.ts';
import type { Side } from './groups.ts';
import type { SnapshotRow } from './history.ts';
import type { DayKind, NetHistory } from './networth.ts';
import { lessSure } from './networth.ts';
import type { RateRow } from './rates.ts';

/**
 * Projections (GOAL-02): where a balance is heading, drawn from the history the app has kept.
 *
 * A projection is a guess and renders as one. So it carries what it assumes (the pace it goes
 * on at), how sure the band around it is, and exactly which days it was drawn from, and the
 * screen says all three beside it.
 *
 * The model is the plainest one a balance allows: it moves each month by what an average month
 * of the last year moved it, and it is as uncertain as those months were unlike each other. A
 * random walk with a drift, in the statistics' words: the line is the drift, and the band
 * widens with the square root of the months ahead, because a run of good and bad months partly
 * cancels. The band is one spread either side, which about two months in three stay inside if
 * the coming years are like the last one. That "if" is the whole assumption, and it is said.
 *
 * Nothing here separates what she put in from what a market did: a balance history cannot.
 * An investment account's pace is its contributions and its returns together, and the screen
 * says so rather than inventing a return (no investment advice, a non-goal).
 *
 * Every amount is integer minor units, the spread included, through a bigint square root
 * (invariant 1). A projection is in the history's currency, already converted at each day's
 * own rate by `netWorthByDay` (invariant 3), so it converts nothing itself.
 */

/**
 * A year of months: long enough that a tax refund, a bonus or a December is one month in
 * twelve rather than the pace itself, short enough to be the habit she has now. Reasoned, not
 * measured.
 */
export const PROJECTION_WINDOW_MONTHS = 12;

/**
 * Under three months there are two steps to measure a spread from, and one payday decides the
 * pace. Also reasoned, not measured.
 */
export const PROJECTION_MIN_MONTHS = 3;

export type Horizon = '1Y' | '5Y' | '10Y';

export const HORIZONS: readonly Horizon[] = ['1Y', '5Y', '10Y'];

export const HORIZON_MONTHS: Readonly<Record<Horizon, number>> = { '1Y': 12, '5Y': 60, '10Y': 120 };

/** What can be projected: the net, or one side as the chart draws it, debt as owed. */
export type ProjectedView = 'net' | Side;

/** One day of a series, as `seriesOf` takes it out of the history. */
export type SeriesDay = {
  readonly on_date: string;
  readonly minor: bigint | null;
  readonly kind: DayKind;
  /** Every account the series will ever count is in it: a day before one joined is not. */
  readonly whole: boolean;
};

/**
 * One view of the history as a series. Debt is turned round to what is owed, a positive figure
 * falling as it is paid, the way the tile and the chart say it.
 */
export function seriesOf(history: NetHistory, view: ProjectedView): SeriesDay[] {
  return history.days.map((day) => {
    if (view === 'net') {
      return {
        on_date: day.on_date,
        minor: day.minor,
        kind: day.kind,
        whole: day.counted >= history.accounts,
      };
    }
    const point = day.sides[view];
    return {
      on_date: day.on_date,
      minor: point.minor === null || view !== 'debt' ? point.minor : -point.minor,
      kind: point.kind,
      whole: point.counted >= history.sideAccounts[view],
    };
  });
}

/* ─── months ────────────────────────────────────────────────────────────────────────────── */

/**
 * `months` from a day, forward or back, kept to the end of a shorter month: 31 Mar less one is
 * 28 Feb, and 31 Jan plus one is 28 Feb too. Each is counted from the same day, never chained,
 * so a year of month-ends does not drift down to the 28th.
 */
export function monthsFrom(isoDate: string, months: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7)) - 1 + months;
  const day = Number(isoDate.slice(8, 10));
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastOfMonth))).toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A day `days` later, or earlier: the chart lays its dates out one per day. */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole months from one day to a later one: 25 Jan to 24 Feb is none, to 25 Feb one. */
export function monthsBetween(from: string, to: string): number {
  let months =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    Number(to.slice(5, 7)) -
    Number(from.slice(5, 7));
  while (months > 0 && monthsFrom(from, months) > to) months -= 1;
  return Math.max(0, months);
}

/** The largest whole number whose square is at most `n`: the spread is a root of a variance. */
export function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/* ─── a balance, projected ──────────────────────────────────────────────────────────────── */

export type PastPoint = {
  readonly on: string;
  readonly minor: bigint;
  readonly kind: DayKind;
};

export type AheadPoint = {
  readonly on: string;
  readonly minor: bigint;
  /** One spread either side. For what is owed, never below nothing. */
  readonly lowMinor: bigint;
  readonly highMinor: bigint;
};

export type Projection =
  | { readonly kind: 'empty' }
  /** Fewer whole months behind it than a pace needs. */
  | { readonly kind: 'too-short'; readonly months: number; readonly since: string | null }
  | {
      readonly kind: 'projected';
      /** The month-ends it was drawn from, oldest first, the last the history's last day. */
      readonly past: readonly PastPoint[];
      readonly ahead: readonly AheadPoint[];
      readonly months: number;
      /** An average month's move over the window: the one assumption it goes on. */
      readonly perMonthMinor: bigint;
      /** How far a single month has strayed from that, one spread. */
      readonly spreadMinor: bigint;
      /** The least sure day in the window: a projection from Monarch's or rebuilt days says so. */
      readonly sureness: DayKind;
      /**
       * For what is owed, the first month-end the line reaches nothing inside the horizon; null
       * when it does not, or for anything else.
       */
      readonly clearsOn: string | null;
    };

/**
 * The series projected `aheadMonths` past its last day. The window is the last twelve
 * month-ends, or as many as the series has whole: a month-end before an account joined would
 * count that account's whole balance as a month's saving, so the window stops there, as a
 * goal's start moves to the first day every account has a row (GOAL-01).
 *
 * `owed` keeps the line and its band at nothing or above: a loan paid off does not go on to
 * be owed a negative amount.
 */
export function project(days: readonly SeriesDay[], aheadMonths: number, owed = false): Projection {
  const last = days[days.length - 1];
  if (last === undefined) return { kind: 'empty' };
  const byDate = new Map(days.map((day) => [day.on_date, day]));

  // Newest first, until a month-end is missing, unwhole or unrated.
  const past: PastPoint[] = [];
  for (let back = 0; back <= PROJECTION_WINDOW_MONTHS; back += 1) {
    const day = byDate.get(monthsFrom(last.on_date, -back));
    if (day === undefined || day.minor === null || !day.whole) break;
    past.push({ on: day.on_date, minor: day.minor, kind: day.kind });
  }
  past.reverse();
  const months = past.length - 1;
  const first = past[0];
  const newest = past[past.length - 1];
  if (first === undefined || newest === undefined || months < PROJECTION_MIN_MONTHS) {
    return { kind: 'too-short', months: Math.max(0, months), since: first?.on ?? null };
  }

  const steps = past.slice(1).map((point, index) => point.minor - (past[index]?.minor ?? 0n));
  const count = BigInt(steps.length);
  const sum = steps.reduce((total, step) => total + step, 0n);
  const squares = steps.reduce((total, step) => total + step * step, 0n);
  // The sample variance, (Σx² − (Σx)²/n) / (n − 1), over n(n − 1) so nothing is divided early.
  const variance = (count * squares - sum * sum) / (count * (count - 1n));
  const perMonthMinor = (newest.minor - first.minor) / BigInt(months);

  let sureness: DayKind = 'read';
  for (const day of days) {
    if (day.on_date >= first.on) sureness = lessSure(sureness, day.kind);
  }

  const floor = (minor: bigint) => (owed && minor < 0n ? 0n : minor);
  const ahead: AheadPoint[] = [];
  let clearsOn: string | null = null;
  for (let month = 1; month <= aheadMonths; month += 1) {
    const on = monthsFrom(last.on_date, month);
    const minor = newest.minor + perMonthMinor * BigInt(month);
    const spread = isqrt(variance * BigInt(month));
    ahead.push({
      on,
      minor: floor(minor),
      lowMinor: floor(minor - spread),
      highMinor: floor(minor + spread),
    });
    if (owed && clearsOn === null && minor <= 0n) clearsOn = on;
  }

  return {
    kind: 'projected',
    past,
    ahead,
    months,
    perMonthMinor,
    spreadMinor: isqrt(variance),
    sureness,
    clearsOn,
  };
}

/* ─── a goal, on the way to its line ────────────────────────────────────────────────────── */

export type GoalPath =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'path';
      /**
       * The goal's balance at each month-end from its start, then today's. Signed as the
       * accounts are for a saving; for a payoff, what is owed, the way its page says it.
       */
      readonly past: readonly PastPoint[];
      /** Where the pace reaches the line: the target, or nothing owed. Null with no finish. */
      readonly finish: { readonly on: string; readonly minor: bigint } | null;
      /** The target, or zero for a payoff: the line the path is heading for. */
      readonly lineMinor: bigint;
    };

/**
 * A goal's balance since its start, a month at a time, and where its pace (GOAL-01's, the one
 * its page states in words) meets the line. The chart draws exactly that sentence: it adds no
 * second pace that could disagree with it.
 *
 * Month-ends are counted back from today, so the last step is always a whole month; the start
 * itself is the first point, from the first day every account has a row when that is later.
 */
export function goalPath(
  goal: GoalRow,
  progress: Progress,
  links: readonly GoalAccountRow[],
  accounts: readonly AccountRow[],
  snapshots: readonly SnapshotRow[],
  rates: readonly RateRow[],
  today: string,
): GoalPath {
  if (progress.kind !== 'save' && progress.kind !== 'payoff') return { kind: 'none' };
  const ids = accountsOf(goal.id, links, accounts).map((account) => account.id);
  const common = firstCommonDay(ids, snapshots);
  const start = common !== null && common > goal.starts_on ? common : goal.starts_on;
  const payoff = progress.kind === 'payoff';
  const shown = (minor: bigint) => (payoff ? (minor < 0n ? -minor : 0n) : minor);

  const dates: string[] = [];
  if (start < today) {
    dates.push(start);
    for (let back = monthsBetween(start, today); back >= 1; back -= 1) {
      const on = monthsFrom(today, -back);
      if (on > start) dates.push(on);
    }
  }
  const past: PastPoint[] = [];
  for (const on of dates) {
    const then = balanceOn(ids, snapshots, rates, goal.currency, on);
    if (then.kind === 'summed') past.push({ on, minor: shown(then.minor), kind: then.sureness });
  }
  const nowMinor = payoff ? progress.owedMinor : progress.balanceMinor;
  past.push({ on: today, minor: nowMinor, kind: 'read' });

  const lineMinor = payoff ? 0n : progress.targetMinor;
  const { pace } = progress;
  const finish =
    !progress.reached && pace.kind === 'moving' && pace.finishOn !== null
      ? { on: pace.finishOn, minor: lineMinor }
      : null;
  return { kind: 'path', past, finish, lineMinor };
}

/** "3 years and 2 months", "5 months": how much history a projection rests on, in words. */
export function describeMonths(months: number): string {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const part = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  if (years === 0) return part(rest, 'month');
  if (rest === 0) return part(years, 'year');
  return `${part(years, 'year')} and ${part(rest, 'month')}`;
}
