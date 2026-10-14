import type { PropertyRow } from './assets.ts';
import type { Total } from './balances.ts';
import type { Side } from './groups.ts';
import type { SnapshotRow } from './history.ts';
import { minorDigits } from './money.ts';
import type { RateRow } from './rates.ts';
import { NET_CURRENCY, sumIn } from './rates.ts';

/**
 * Net worth by day (ACCT-04), from ACCT-03's `balance_snapshots`, for the dashboard's chart.
 *
 * Each day sums every live account's balance on it, converted at the newest rate dated that
 * day or before, so a past day computes the same later (invariant 3). A day an account has no
 * row for — the bank did not refresh, so the night kept nothing new — carries its last row
 * forward, which is what its balance was as far as anybody knows. Before an account's first
 * row it is not in the day at all, and the day says how many accounts it counted.
 *
 * A day is `read` only when every figure in it is a reading. One rebuilt figure makes it
 * `rebuilt`, drawn as a guess: a sum is only as sure as its least sure part. Between the two
 * sits `monarch` (ACCT-05): a balance Monarch read from the bank, before Dinora read it itself.
 * A reading, not a guess, but not Dinora's, so it is said as Monarch's. Beside it sits
 * `statement` (ACCT-20): a balance copied from the lender's own statement, as sure as Monarch's
 * and for the same reason, and said as a statement's.
 *
 * Each day also carries the same sum split by side — cash, debt, investments (added 24 Sep,
 * after ACCT-04) — so the chart can draw each on its own or stacked. A side's point follows
 * the same rules as the day's, over only its own accounts: its own kind, its own count. An
 * account in no side counts toward the day's net and toward none of the three, so the three
 * can sum to less than the net, as the tiles above the chart already do.
 *
 * Property (ACCT-06) is the fourth side: the assets Nora values herself, each carried forward
 * from the newest value set on or before the day, as an account's balance is. A value set
 * before the chart's first day is simply what the asset was worth on it: the gold bought in
 * 2022 does not stretch the line back to 2022, which only accounts' rows decide. An asset is
 * not an account, so it does not change how many accounts a day counted. A crypto holding
 * (ACCT-21) is carried the same way and counts toward investments instead (`assetSide`).
 *
 * A value she entered does not change how a day is drawn: it is her figure, neither read nor
 * guessed, and its age is shown beside the asset instead. One of Monarch's makes the day
 * Monarch's, as one of its balances does.
 *
 * Nor does a market estimate (ACCT-11), though it is a guess. Drawn as one, the apartment's
 * weekly estimate would dash every day of net worth from the first night it was read, which
 * says nothing about the accounts the line is mostly made of. It is marked as an estimate
 * where the value is shown instead: on the Property card and the asset's page.
 */

export type DayKind = 'read' | 'monarch' | 'statement' | 'rebuilt';

const SURENESS: Readonly<Record<DayKind, number>> = {
  read: 2,
  monarch: 1,
  statement: 1,
  rebuilt: 0,
};

/** The less sure of two kinds: what a day, or the step between two days, is drawn as. */
export function lessSure(a: DayKind, b: DayKind): DayKind {
  return SURENESS[a] <= SURENESS[b] ? a : b;
}

/** The order they stack in: what is owned from zero upward, then what is owed below it. */
export const SIDES = ['cash', 'investments', 'property', 'debt'] as const satisfies readonly Side[];

export type SidePoint = {
  /** Signed, as the accounts are: debt is negative, and the screen turns it round to say owed. */
  readonly minor: bigint | null;
  readonly kind: DayKind;
  readonly counted: number;
};

export type NetDay = {
  readonly on_date: string;
  /** Null when some currency in the day has no rate yet; the line breaks rather than dips. */
  readonly minor: bigint | null;
  readonly kind: DayKind;
  /** How many accounts the day counted. Fewer than the history's `accounts` is a partial day. */
  readonly counted: number;
  readonly sides: Readonly<Record<Side, SidePoint>>;
};

export type NetHistory = {
  readonly currency: string;
  readonly days: readonly NetDay[];
  /** Accounts with at least one row: the most a day can count. */
  readonly accounts: number;
  /** The same, for each side: the most a side's point can count, assets included. */
  readonly sideAccounts: Readonly<Record<Side, number>>;
  /** The first night the bank's balance was read and kept, or null before the first night. */
  readonly firstRead: string | null;
  readonly readDays: number;
  readonly monarchDays: number;
  readonly statementDays: number;
  readonly rebuiltDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function nextDay(isoDate: string): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

type Tally = {
  sums: Map<string, { minor: bigint; accounts: number }>;
  kind: DayKind;
  counted: number;
};

function tally(): Tally {
  return { sums: new Map(), kind: 'read', counted: 0 };
}

type Figure = {
  readonly currency: string;
  readonly minor: number;
  readonly kind: DayKind;
};

function add(into: Tally, figure: Figure, counts = true): void {
  if (counts) into.counted += 1;
  into.kind = lessSure(into.kind, figure.kind);
  const held = into.sums.get(figure.currency) ?? { minor: 0n, accounts: 0 };
  held.minor += BigInt(figure.minor);
  held.accounts += 1;
  into.sums.set(figure.currency, held);
}

function ofSnapshot(row: SnapshotRow): Figure {
  return { currency: row.currency, minor: row.balance_minor, kind: row.kind };
}

/** Hers and an estimate count as read: see the top of this file. */
function ofProperty(row: PropertyRow): Figure {
  return {
    currency: row.currency,
    minor: row.minor,
    kind: row.source === 'monarch' ? 'monarch' : 'read',
  };
}

/** The newest row on or before `day`. Days only move forward, so the index does too. */
function newest<Row extends { readonly on_date: string }>(
  rows: readonly Row[],
  cursor: Map<string, number>,
  key: string,
  day: string,
): Row | undefined {
  let index = cursor.get(key) ?? -1;
  while (index + 1 < rows.length && (rows[index + 1]?.on_date ?? '') <= day) index += 1;
  cursor.set(key, index);
  return rows[index];
}

function settle(from: Tally, rates: readonly RateRow[], currency: string, day: string): SidePoint {
  const totals: Total[] = [...from.sums].map(([code, sum]) => ({ currency: code, ...sum }));
  const sum = sumIn(totals, rates, currency, day);
  return {
    minor: sum.kind === 'summed' ? sum.minor : null,
    kind: from.kind,
    counted: from.counted,
  };
}

/**
 * `accounts` is the live accounts, each with the side it counts toward (`sideOf`, null for
 * none): a row for an account that is gone is left out, so the last day agrees with the net
 * the screen shows above the chart. `property` is `propertyRows`, the live assets' values in
 * the order they were set.
 */
export function netWorthByDay(
  snapshots: readonly SnapshotRow[],
  accounts: ReadonlyMap<string, Side | null>,
  rates: readonly RateRow[],
  property: readonly PropertyRow[] = [],
  currency = NET_CURRENCY,
): NetHistory {
  const byAccount = new Map<string, SnapshotRow[]>();
  let first: string | null = null;
  let last: string | null = null;
  let firstRead: string | null = null;
  for (const row of snapshots) {
    if (row.deleted_at !== null || !accounts.has(row.account_id)) continue;
    const rows = byAccount.get(row.account_id) ?? [];
    rows.push(row);
    byAccount.set(row.account_id, rows);
    // ISO dates: lexical order is date order.
    if (first === null || row.on_date < first) first = row.on_date;
    if (last === null || row.on_date > last) last = row.on_date;
    if (row.kind === 'read' && (firstRead === null || row.on_date < firstRead)) {
      firstRead = row.on_date;
    }
  }
  for (const rows of byAccount.values()) rows.sort((a, b) => a.on_date.localeCompare(b.on_date));
  const byAsset = new Map<string, PropertyRow[]>();
  for (const row of property) {
    const rows = byAsset.get(row.asset_id) ?? [];
    rows.push(row);
    byAsset.set(row.asset_id, rows);
  }
  const sideAccounts: Record<Side, number> = {
    cash: 0,
    investments: 0,
    property: 0,
    debt: 0,
  };
  for (const rows of byAsset.values()) {
    const side = rows[0]?.side;
    if (side !== undefined) sideAccounts[side] += 1;
  }
  for (const account of byAccount.keys()) {
    const side = accounts.get(account) ?? null;
    if (side !== null) sideAccounts[side] += 1;
  }

  const days: NetDay[] = [];
  let readDays = 0;
  let monarchDays = 0;
  let statementDays = 0;
  let rebuiltDays = 0;
  if (first !== null && last !== null) {
    const cursor = new Map<string, number>();
    for (let day = first; day <= last; day = nextDay(day)) {
      const all = tally();
      const bySide: Record<Side, Tally> = {
        cash: tally(),
        investments: tally(),
        property: tally(),
        debt: tally(),
      };
      for (const [account, rows] of byAccount) {
        const row = newest(rows, cursor, account, day);
        if (row === undefined) continue;
        add(all, ofSnapshot(row));
        const side = accounts.get(account) ?? null;
        if (side !== null) add(bySide[side], ofSnapshot(row));
      }
      for (const [asset, rows] of byAsset) {
        const row = newest(rows, cursor, `asset:${asset}`, day);
        if (row === undefined) continue;
        add(all, ofProperty(row), false);
        add(bySide[row.side], ofProperty(row));
      }
      const { minor, kind, counted } = settle(all, rates, currency, day);
      days.push({
        on_date: day,
        minor,
        kind,
        counted,
        sides: {
          cash: settle(bySide.cash, rates, currency, day),
          investments: settle(bySide.investments, rates, currency, day),
          property: settle(bySide.property, rates, currency, day),
          debt: settle(bySide.debt, rates, currency, day),
        },
      });
      if (kind === 'read') readDays += 1;
      else if (kind === 'monarch') monarchDays += 1;
      else if (kind === 'statement') statementDays += 1;
      else rebuiltDays += 1;
    }
  }

  return {
    currency,
    days,
    accounts: byAccount.size,
    sideAccounts,
    firstRead,
    readDays,
    monarchDays,
    statementDays,
    rebuiltDays,
  };
}

/* ─── the stacked columns ───────────────────────────────────────────────────────────────── */

export type Period = 'day' | 'week' | 'month';

export type Column = {
  /** The period's first day: a Monday for a week, the 1st for a month. */
  readonly from: string;
  /** The last day of the period the history holds, whose balances the column shows. */
  readonly day: NetDay;
};

const PERIODS: readonly Period[] = ['day', 'week', 'month'];

function startOf(period: Period, isoDate: string): string {
  switch (period) {
    case 'day':
      return isoDate;
    case 'week': {
      const at = Date.parse(`${isoDate}T00:00:00Z`);
      const sinceMonday = (new Date(at).getUTCDay() + 6) % 7;
      return new Date(at - sinceMonday * DAY_MS).toISOString().slice(0, 10);
    }
    case 'month':
      return `${isoDate.slice(0, 7)}-01`;
  }
}

/**
 * The days as at most `most` columns, in the finest period that fits: a day each for a short
 * history, a week or a month for a long one. Monarch's history (ACCT-05) is over 600 days,
 * which as daily columns would be thinner than a pixel on a phone.
 *
 * A column is a balance, not a flow, so it is the period's last day, not a sum or an average:
 * September's column is where things stood at the end of September, or today if that is
 * sooner. Past a month's worth of columns it stays monthly and the columns get thinner.
 */
export function columnsOf(
  days: readonly NetDay[],
  most: number,
): { readonly period: Period; readonly columns: readonly Column[] } {
  let chosen: { period: Period; columns: Column[] } = { period: 'month', columns: [] };
  for (const period of PERIODS) {
    const columns: Column[] = [];
    for (const day of days) {
      const from = startOf(period, day.on_date);
      const last = columns[columns.length - 1];
      if (last !== undefined && last.from === from) columns[columns.length - 1] = { from, day };
      else columns.push({ from, day });
    }
    chosen = { period, columns };
    if (columns.length <= most) break;
  }
  return chosen;
}

/** "Sep 2026", "Week of 21 Sep 2026", or the day itself: what a column is labelled with. */
export function describePeriod(period: Period, from: string, locale: string | undefined): string {
  const at = Date.parse(`${from}T00:00:00Z`);
  switch (period) {
    case 'day':
      return describeDay(from, locale);
    // With the year: a year of weekly columns runs from one September to the next (UI-07).
    case 'week':
      return `Week of ${describeDayWithYear(from, locale)}`;
    case 'month':
      return new Intl.DateTimeFormat(locale, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(at);
  }
}

/* ─── the chart's axis ──────────────────────────────────────────────────────────────────── */

/**
 * Round figures in whole units of the currency (dollars, not cents) spanning every value:
 * about four steps of 1, 2 or 5 times a power of ten. Whole units so the axis is formatted
 * from integers, like every other amount on the screen.
 */
export function axisTicks(values: readonly bigint[], currency = NET_CURRENCY): number[] {
  const scale = 10n ** BigInt(minorDigits(currency) ?? 2);
  let min = values[0] ?? 0n;
  let max = min;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // Outward to whole units: bigint division truncates toward zero.
  const low = Number(min / scale) - (min < 0n && min % scale !== 0n ? 1 : 0);
  const high = Number(max / scale) + (max > 0n && max % scale !== 0n ? 1 : 0);
  const rough = Math.max(1, high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 1);
  const ticks: number[] = [];
  let tick = Math.floor(low / step) * step;
  ticks.push(tick);
  // At least two, so a flat line still has a range to sit in.
  while (tick < high || ticks.length < 2) {
    tick += step;
    ticks.push(tick);
  }
  return ticks;
}

/** "Thu 24 Sep 2026", in UTC: the days are UTC days (ACCT-03), and a Spanish evening must not move one. */
export function describeDay(isoDate: string, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.parse(`${isoDate}T00:00:00Z`));
}

/** "24 Sep", for the axis. */
export function describeShortDay(isoDate: string, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(Date.parse(`${isoDate}T00:00:00Z`));
}

/** "24 Sep 2026": a day with its year and nothing else, for the ends of the axis. */
export function describeDayWithYear(isoDate: string, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.parse(`${isoDate}T00:00:00Z`));
}

/** "Mar", or "Jan 2026" with its year. */
function describeMonth(isoDate: string, locale: string | undefined, withYear: boolean): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(Date.parse(`${isoDate}T00:00:00Z`));
}

/* ─── the chart's range ─────────────────────────────────────────────────────────────────── */

/**
 * How much of the history the chart draws (UI-07). Since Monarch's history (ACCT-05) the whole
 * of it is over two years, and drawn whole, last month was a few pixels wide.
 */
export type Range = '1M' | '3M' | 'YTD' | '1Y' | 'All';

export const RANGES: readonly Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];

/** Back `months` from a day, kept to the end of a shorter month: 31 Mar less one is 28 Feb. */
function monthsBefore(isoDate: string, months: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7)) - 1 - months;
  const day = Number(isoDate.slice(8, 10));
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastOfMonth))).toISOString().slice(0, 10);
}

/**
 * The first day a range draws, counted back from the history's last day rather than the
 * clock's: the newest day is where the chart ends, and a night the sync missed must not
 * shorten the month. Null for All.
 */
export function rangeStart(range: Range, lastDay: string): string | null {
  switch (range) {
    case '1M':
      return monthsBefore(lastDay, 1);
    case '3M':
      return monthsBefore(lastDay, 3);
    case 'YTD':
      return `${lastDay.slice(0, 4)}-01-01`;
    case '1Y':
      return monthsBefore(lastDay, 12);
    case 'All':
      return null;
  }
}

/**
 * The history cut to a range, with its counts taken again over the days left, so the key
 * offers Monarch's line only when some of it is in view. What a day sums to is unchanged: a
 * range narrows what is drawn, never a figure.
 */
export function inRange(history: NetHistory, range: Range): NetHistory {
  const last = history.days[history.days.length - 1];
  const from = last === undefined ? null : rangeStart(range, last.on_date);
  if (from === null) return history;
  const days = history.days.filter((day) => day.on_date >= from);
  return {
    ...history,
    days,
    readDays: days.filter((day) => day.kind === 'read').length,
    monarchDays: days.filter((day) => day.kind === 'monarch').length,
    statementDays: days.filter((day) => day.kind === 'statement').length,
    rebuiltDays: days.filter((day) => day.kind === 'rebuilt').length,
  };
}

/**
 * Empty days drawn after the last one, so the line stops short of the right edge rather than
 * running into it (Nora, 27 Sep 2026). A share of the days drawn, so it reads the same at
 * every range: a day on a month, about two weeks on a year, a month on two years.
 */
const END_PAD = 0.04;

export function endPad(days: number): number {
  return days < 2 ? 0 : Math.max(1, Math.round((days - 1) * END_PAD));
}

/* ─── the chart's dates ─────────────────────────────────────────────────────────────────── */

export type DateTick = { readonly index: number; readonly label: string };

/** Months since year 0, so a stride of 12 lands on every January and 3 on every quarter. */
function monthNumber(isoDate: string): number {
  return Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7)) - 1;
}

const MONTH_STRIDES = [1, 2, 3, 6, 12, 24, 60, 120] as const;

/** An end's label carries its year and is about twice as wide, so it keeps this many gaps clear. */
const END_CLEARANCE = 1.5;

/**
 * The dates under a chart (UI-07): the two ends with their years, and between them months —
 * "Mar", with the year only at January, "Jan 2026" — every one, two, three, six or twelve,
 * whichever is the most that fits. The axis was day and month throughout, so two years read
 * "Sep 26 · Jan 26 · May 27 · Sep 26", which look like years.
 *
 * A range that crosses fewer than two months is marked in evenly spaced days instead.
 *
 * `dates` is one per point or column, in order; `monthly` says each is a whole month, whose
 * ends read "Sep 2024" rather than a day. `most` is how many labels fit across: a label
 * closer than one gap to another, or one and a half to an end, is left out.
 */
export function dateTicks(
  dates: readonly string[],
  most: number,
  monthly: boolean,
  locale: string | undefined,
): DateTick[] {
  const count = dates.length;
  const end = (index: number): DateTick => {
    const on = dates[index] ?? '';
    return {
      index,
      label: monthly ? describeMonth(on, locale, true) : describeDayWithYear(on, locale),
    };
  };
  if (count === 0) return [];
  if (count === 1) return [end(0)];
  const last = count - 1;
  const gap = last / Math.max(1, most - 1);
  const clear = (index: number) =>
    index >= gap * END_CLEARANCE && last - index >= gap * END_CLEARANCE;
  const spaced = (indices: readonly number[]) =>
    indices.every((index, i) => i === 0 || index - (indices[i - 1] ?? 0) >= gap);

  const firsts: number[] = [];
  for (let index = 1; index < last; index += 1) {
    if (monthNumber(dates[index] ?? '') !== monthNumber(dates[index - 1] ?? '')) {
      firsts.push(index);
    }
  }

  const middle: DateTick[] = [];
  if (firsts.length >= 2) {
    for (const stride of MONTH_STRIDES) {
      const picked = firsts.filter(
        (index) => monthNumber(dates[index] ?? '') % stride === 0 && clear(index),
      );
      if (!spaced(picked)) continue;
      for (const index of picked) {
        const on = dates[index] ?? '';
        middle.push({ index, label: describeMonth(on, locale, on.slice(5, 7) === '01') });
      }
      break;
    }
  } else {
    // Evenly over what the ends leave clear, as many as fit a gap apart.
    const from = gap * END_CLEARANCE;
    const span = last - 2 * from;
    // The epsilon keeps a span of exactly two gaps from rounding down to one and a bit.
    const fit = span < 0 ? 0 : Math.floor(span / gap + 1e-9) + 1;
    const picked = new Set<number>();
    // Rounded inward: on a chart of few points, rounding carried one onto an end's label.
    const low = Math.ceil(from);
    const high = Math.floor(last - from);
    for (let i = 0; i < fit && low <= high; i += 1) {
      const index = Math.round(from + (fit === 1 ? span / 2 : (i * span) / (fit - 1)));
      picked.add(Math.min(high, Math.max(low, index)));
    }
    for (const index of picked) {
      middle.push({ index, label: describeShortDay(dates[index] ?? '', locale) });
    }
  }
  return [end(0), ...middle, end(last)];
}
