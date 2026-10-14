import { formatMinor } from '@dinora/core/balances';
import type { Side } from '@dinora/core/groups';
import type { Column, NetDay, NetHistory, Period, Range } from '@dinora/core/networth';
import {
  axisTicks,
  columnsOf,
  dateTicks,
  describeDay,
  describePeriod,
  endPad,
  inRange,
  RANGES,
  SIDES,
} from '@dinora/core/networth';
import type { AheadPoint, Horizon } from '@dinora/core/projection';
import { addDays, HORIZON_MONTHS, HORIZONS, project, seriesOf } from '@dinora/core/projection';
import { daysBetween } from '@dinora/core/terms';
import { useState } from 'react';

import {
  Axes,
  DateAxis,
  frame,
  labelsAcross,
  LineSwatch,
  MARGIN,
  Plot,
  Tooltip,
  useWidth,
} from './chart.tsx';
import { describeMonth, wholeUnits } from './Projection.tsx';

/** The browser's own: amounts and dates read the way the rest of the device does. */
const LOCALE = undefined;

/** The narrowest a stacked column is allowed before the columns go to weeks, then months. */
const COLUMN_PX = 10;

/** One series as a line, or the four sides stacked as columns. */
export type View = 'net' | Side | 'stacked';

export const VIEWS: readonly View[] = ['net', 'cash', 'investments', 'property', 'debt', 'stacked'];

export const VIEW_NAMES: Readonly<Record<View, string>> = {
  net: 'Net worth',
  cash: 'Cash',
  investments: 'Investments',
  property: 'Property',
  debt: 'Debt owed',
  stacked: 'Stacked',
};

const SIDE_NAMES: Readonly<Record<Side, string>> = {
  cash: 'Cash',
  investments: 'Investments',
  property: 'Property',
  debt: 'Debt owed',
};

/**
 * Net worth by day (ACCT-04), or one of the sides it is made of, or the four stacked:
 * property joined cash, investments and debt with ACCT-06.
 *
 * Every day is drawn alike, wherever its balances came from — read that night, Monarch's
 * history (ACCT-05), a lender's statement or rebuilt from transactions (ACCT-03). Nora, 27 Sep
 * 2026: she does not care where a figure came from, and a key of four line styles was the
 * chart's loudest part. What is still said is a day that leaves accounts out, because that
 * changes what the figure means.
 *
 * Debt is drawn as owed, a positive figure falling as it is paid, the way the tile above says
 * it; stacked, it hangs below zero, so the columns' height above the axis less their depth
 * below it is the net.
 *
 * There is no table under it (Nora, 27 Sep 2026): the tooltip reads each day, by pointer or
 * arrow keys, and the label says the range and where it ends.
 *
 * Positions are floats, which is fine for pixels; every amount a person reads — tooltip,
 * axis — is formatted from integers, the axis in whole dollars and the rest from
 * minor units (invariant 1).
 */
export function NetWorthChart({
  history,
  view,
  ahead = [],
}: {
  readonly history: NetHistory;
  readonly view: View;
  /** The line's projection (GOAL-02), drawn on from its last day. */
  readonly ahead?: readonly AheadPoint[];
}) {
  return view === 'stacked' ? (
    <StackedChart history={history} />
  ) : (
    <LineChart history={history} view={view} ahead={ahead} />
  );
}

/* ─── the dashboard's section ───────────────────────────────────────────────────────────── */

const HEADINGS: Readonly<Record<View, string>> = {
  net: 'Net worth by day',
  cash: 'Cash by day',
  investments: 'Investments by day',
  property: 'Property by day',
  debt: 'Debt owed by day',
  stacked: 'Cash, investments, property and debt',
};

/** What a screen reader says for each chip, which would otherwise read "1M" as "one em". */
const HORIZON_NAMES: Readonly<Record<Horizon, string>> = {
  '1Y': 'One year ahead',
  '5Y': 'Five years ahead',
  '10Y': 'Ten years ahead',
};

const RANGE_NAMES: Readonly<Record<Range, string>> = {
  '1M': 'One month',
  '3M': 'Three months',
  YTD: 'Year to date',
  '1Y': 'One year',
  All: 'All of it',
};

/**
 * The chart, with nothing said around it but its switches. Where a figure came from is not
 * said: Nora, 27 Sep 2026, does not care, and it had been the chart's loudest part. Nor is
 * there a note by the title on the accounts the early days leave out, which before the first
 * night are the investments, whose past cannot be rebuilt (ACCT-03): she took that off the
 * same day, and a day's tooltip still says what it leaves out.
 *
 * Which series it draws is a switch above it, net worth first. The choice is not kept: the
 * dashboard opens on net worth, the figure it leads with.
 *
 * Beside it, how far back (UI-07), opening on a year: the whole history is over two years
 * since ACCT-05, and drawn whole, last month was a few pixels wide. Not kept either.
 *
 * And how far ahead (GOAL-02), opening on a year, as far ahead as the chart opens looking back,
 * so which way it is going is plain. The projection is always drawn from the whole history,
 * whatever the range. Not for property, nor stacked. Nothing is said under it: what it assumes
 * was a paragraph Nora did not read (27 Sep 2026), and the band says how sure it is.
 */
export function History({ history }: { readonly history: NetHistory }) {
  const [view, setView] = useState<View>('net');
  const [range, setRange] = useState<Range>('1Y');
  const [horizon, setHorizon] = useState<Horizon>('1Y');
  const projected =
    view === 'stacked' ||
    view === 'property' ||
    (view === 'net' ? history.accounts : history.sideAccounts[view]) === 0
      ? null
      : view;
  const projection =
    projected === null
      ? null
      : project(seriesOf(history, projected), HORIZON_MONTHS[horizon], projected === 'debt');
  return (
    <section className="history" aria-labelledby="history-title">
      <div className="history-head">
        <h2 id="history-title">{HEADINGS[view]}</h2>
      </div>
      {history.days.length === 0 ? (
        <p className="muted small">
          Nothing to draw yet. The first nightly read starts the line, and the 90 days before it are
          rebuilt from transactions.
        </p>
      ) : (
        <>
          <fieldset className="views">
            <legend className="muted small">Show</legend>
            {VIEWS.map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="history-view"
                  value={option}
                  checked={view === option}
                  onChange={() => setView(option)}
                />
                {VIEW_NAMES[option]}
              </label>
            ))}
          </fieldset>
          <fieldset className="views">
            <legend className="muted small">Over</legend>
            {RANGES.map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="history-range"
                  value={option}
                  aria-label={RANGE_NAMES[option]}
                  checked={range === option}
                  onChange={() => setRange(option)}
                />
                {option}
              </label>
            ))}
          </fieldset>
          {projected !== null && (
            <fieldset className="views">
              <legend className="muted small">Ahead</legend>
              {HORIZONS.map((option) => (
                <label key={option}>
                  <input
                    type="radio"
                    name="history-horizon"
                    value={option}
                    aria-label={HORIZON_NAMES[option]}
                    checked={horizon === option}
                    onChange={() => setHorizon(option)}
                  />
                  {option}
                </label>
              ))}
            </fieldset>
          )}
          <NetWorthChart
            history={inRange(history, range)}
            view={view}
            ahead={projection?.kind === 'projected' ? projection.ahead : []}
          />
        </>
      )}
    </section>
  );
}

/* ─── one series as a line ──────────────────────────────────────────────────────────────── */

type Point = { readonly minor: bigint | null; readonly counted: number };

/** The view's figure for a day, with debt turned round to what is owed. */
function pointOf(day: NetDay, view: Exclude<View, 'stacked'>): Point {
  if (view === 'net') return day;
  const point = day.sides[view];
  if (view !== 'debt' || point.minor === null) return point;
  return { ...point, minor: -point.minor };
}

function LineChart({
  history,
  view,
  ahead,
}: {
  readonly history: NetHistory;
  readonly view: Exclude<View, 'stacked'>;
  readonly ahead: readonly AheadPoint[];
}) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { days, currency } = history;
  const points = days.map((day) => pointOf(day, view));
  const accounts = view === 'net' ? history.accounts : history.sideAccounts[view];
  const name = VIEW_NAMES[view];

  const values = [
    ...points.flatMap((point) => (point.minor === null ? [] : [point.minor])),
    ...ahead.flatMap((point) => [point.lowMinor, point.highMinor]),
  ];
  if (accounts === 0) {
    return (
      <p className="muted small">
        {view === 'property'
          ? 'Nothing you own is valued yet. Add it below, under Property, and it joins this line.'
          : `No account counts as ${name.toLowerCase()} yet. Set an account's group below and it joins this line.`}
      </p>
    );
  }
  const lastIndex = days.length - 1;
  const lastDay = days[lastIndex];
  const now = points[lastIndex];
  if (values.length === 0 || lastDay === undefined || now === undefined) return null;

  // Laid out by day, history and projection alike, so a month ahead is as wide as one behind:
  // each projected month sits on its own date, and the padding goes after whichever ends last.
  const aheadAt = ahead.map((point) => lastIndex + daysBetween(lastDay.on_date, point.on));
  const reach = (aheadAt[aheadAt.length - 1] ?? lastIndex) + 1;
  const span = reach + endPad(reach);
  const plot = frame(width, span, axisTicks(values, currency), currency);
  const { x, y, plotWidth, plotHeight } = plot;
  const axisDates = Array.from({ length: reach }, (_, index) =>
    index <= lastIndex ? (days[index]?.on_date ?? '') : addDays(lastDay.on_date, index - lastIndex),
  );

  /** Indices past the last day are the months ahead, in order. */
  const xAt = (index: number) =>
    x(index <= lastIndex ? index : (aheadAt[index - days.length] ?? 0));
  const pickAt = (offset: number) => {
    const day = Math.round((offset / plotWidth) * (span - 1));
    if (day <= lastIndex || aheadAt.length === 0) return day;
    let best = 0;
    for (const [k, at] of aheadAt.entries()) {
      if (Math.abs(at - day) < Math.abs((aheadAt[best] ?? 0) - day)) best = k;
    }
    return days.length + best;
  };

  const shownPast = active === null || active > lastIndex ? null : (points[active] ?? null);
  const shownDay = active === null ? null : (days[active] ?? null);
  const shownAhead = active === null ? null : (ahead[active - days.length] ?? null);
  const shownMinor = shownPast?.minor ?? shownAhead?.minor ?? null;

  const from = now.minor === null ? [] : [[lastIndex, now.minor] as const];
  const projected = [...from, ...ahead.map((point, k) => [aheadAt[k] ?? 0, point.minor] as const)];
  const band =
    now.minor === null || ahead.every((point) => point.highMinor === point.lowMinor)
      ? null
      : [
          `${x(lastIndex)},${y(now.minor)}`,
          ...ahead.map((point, k) => `${x(aheadAt[k] ?? 0)},${y(point.highMinor)}`),
          ...ahead.map((point, k) => `${x(aheadAt[k] ?? 0)},${y(point.lowMinor)}`).reverse(),
        ].join(' ');

  return (
    <figure className="chart">
      {ahead.length > 0 && (
        <div className="chart-key small muted" aria-hidden="true">
          <span>
            <LineSwatch className={`line ${view}`} />
            So far
          </span>
          <span>
            <LineSwatch className={`line ${view} projected`} />
            Projected{band === null ? '' : ', with its likely range'}
          </span>
        </div>
      )}
      <Plot
        box={box}
        width={width}
        count={days.length + ahead.length}
        plotWidth={plotWidth}
        label={summary(name, days, points, ahead, currency)}
        setActive={setActive}
        pickAt={pickAt}
        tooltip={
          active === null ? null : shownAhead !== null ? (
            <Tooltip left={xAt(active)} width={width}>
              <strong>About {wholeUnits(shownAhead.minor, currency)}</strong>
              <span className="muted">{describeMonth(shownAhead.on)}, projected</span>
              {shownAhead.highMinor !== shownAhead.lowMinor && (
                <span className="muted">
                  Likely {wholeUnits(shownAhead.lowMinor, currency)} to{' '}
                  {wholeUnits(shownAhead.highMinor, currency)}
                </span>
              )}
            </Tooltip>
          ) : shownPast !== null && shownDay !== null ? (
            <Tooltip left={xAt(active)} width={width}>
              <strong>
                {shownPast.minor === null
                  ? 'No rate yet'
                  : formatMinor(shownPast.minor, currency, LOCALE)}
              </strong>
              <span className="muted">{describeDay(shownDay.on_date, LOCALE)}</span>
              {leftOut(shownPast, accounts, view) !== '' && (
                <span className="muted">{leftOut(shownPast, accounts, view)}</span>
              )}
            </Tooltip>
          ) : null
        }
      >
        <Axes plot={plot} currency={currency} />
        <DateAxis
          ticks={dateTicks(axisDates, labelsAcross(plotWidth), false, LOCALE)}
          count={axisDates.length}
          x={x}
        />
        {band !== null && <polygon className={`band ${view}`} points={band} />}
        {segments(points).map((segment) => (
          <polyline
            key={segment.from}
            className={`line ${view}`}
            points={segment.points.map(([index, minor]) => `${x(index)},${y(minor)}`).join(' ')}
          />
        ))}
        {projected.length > 1 && (
          <polyline
            className={`line ${view} projected`}
            points={projected.map(([index, minor]) => `${x(index)},${y(minor)}`).join(' ')}
          />
        )}
        {active !== null && (
          <g className="crosshair">
            <line x1={xAt(active)} x2={xAt(active)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />
            {shownMinor !== null && (
              <circle className={view} cx={xAt(active)} cy={y(shownMinor)} r={4} />
            )}
          </g>
        )}
      </Plot>
    </figure>
  );
}

/** The accounts a day does not count yet, or nothing. For property, `accounts` is assets. */
function leftOut(point: Point, accounts: number, view: Exclude<View, 'stacked'>): string {
  const missing = accounts - point.counted;
  if (missing <= 0) return '';
  const [one, many] = view === 'property' ? ['asset', 'assets'] : ['account', 'accounts'];
  return `Leaves out ${missing} ${missing === 1 ? one : many}`;
}

function summary(
  name: string,
  days: readonly NetDay[],
  points: readonly Point[],
  ahead: readonly AheadPoint[],
  currency: string,
): string {
  const first = days[0];
  const last = days[days.length - 1];
  const lastPoint = points[points.length - 1];
  if (first === undefined || last === undefined) return `${name} by day`;
  const end =
    lastPoint?.minor === null || lastPoint === undefined
      ? ''
      : `, ${formatMinor(lastPoint.minor, currency, LOCALE)} on the last`;
  const furthest = ahead[ahead.length - 1];
  const then =
    furthest === undefined
      ? ''
      : `, projected to about ${wholeUnits(furthest.minor, currency)} by ${describeMonth(furthest.on)}`;
  return `${name} by day, ${describeDay(first.on_date, LOCALE)} to ${describeDay(last.on_date, LOCALE)}${end}${then}. Use the arrow keys to read each day.`;
}

type Segment = {
  readonly from: number;
  readonly points: readonly (readonly [number, bigint])[];
};

/** The line as unbroken runs: a day with no figure breaks it. */
function segments(points: readonly Point[]): Segment[] {
  const runs: { from: number; points: [number, bigint][] }[] = [];
  let open = false;
  for (const [index, point] of points.entries()) {
    if (point.minor === null) {
      open = false;
      continue;
    }
    const run = runs[runs.length - 1];
    if (open && run !== undefined) run.points.push([index, point.minor]);
    else runs.push({ from: index, points: [[index, point.minor]] });
    open = true;
  }
  return runs;
}

/* ─── the four sides, stacked ───────────────────────────────────────────────────────────── */

type Stack = {
  readonly side: Side;
  /** The segment's two ends, in minor units: from nearer zero to further from it. */
  readonly from: bigint;
  readonly to: bigint;
};

/**
 * Each side from zero outward, positive above and negative below, in a fixed order so a
 * colour stays in the same place from column to column. An overdrawn checking account or a
 * card in credit crosses to the other side of the axis rather than cancelling a neighbour.
 */
function stack(day: NetDay): Stack[] {
  let above = 0n;
  let below = 0n;
  const stacks: Stack[] = [];
  for (const side of SIDES) {
    const minor = day.sides[side].minor;
    if (minor === null || minor === 0n) continue;
    if (minor > 0n) {
      stacks.push({ side, from: above, to: above + minor });
      above += minor;
    } else {
      stacks.push({ side, from: below, to: below + minor });
      below += minor;
    }
  }
  return stacks;
}

function StackedChart({ history }: { readonly history: NetHistory }) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { currency } = history;
  const plotWidthGuess = Math.max(1, width - MARGIN.left - MARGIN.right);
  const { period, columns } = columnsOf(
    history.days,
    Math.max(1, Math.floor(plotWidthGuess / COLUMN_PX)),
  );

  const values = columns.flatMap(({ day }) => {
    const ends = stack(day).flatMap((s) => [s.from, s.to]);
    return day.minor === null ? ends : [...ends, day.minor];
  });
  if (values.length === 0) return null;

  const plot = frame(width, columns.length, axisTicks([0n, ...values], currency), currency, true);
  const { x, y, plotWidth, plotHeight } = plot;
  const step = plotWidth / columns.length;
  const barWidth = Math.max(1, Math.min(48, step * 0.7));
  const shown = active === null ? null : (columns[active] ?? null);
  // Property counts assets, not accounts, so it is not part of what the accounts' sides leave.
  const unsided =
    history.accounts -
    SIDES.filter((s) => s !== 'property').reduce((n, s) => n + history.sideAccounts[s], 0);

  const netPoints = columns.flatMap(({ day }, index) =>
    day.minor === null ? [] : [`${x(index)},${y(day.minor)}`],
  );

  return (
    <figure className="chart">
      <div className="chart-key small muted" aria-hidden="true">
        {SIDES.map((side) => (
          <span key={side}>
            <svg width="12" height="12">
              <rect width="12" height="12" rx="2" className={`segment ${side}`} />
            </svg>
            {SIDE_NAMES[side]}
            {side === 'debt' && ', below zero'}
          </span>
        ))}
        <span>
          <LineSwatch className="line net-overlay" />
          Net worth
        </span>
      </div>
      <p className="muted small">
        {period === 'day' ? 'Each day' : period === 'week' ? 'Each week' : 'Each month'}
        {period === 'day' ? '' : ', as it stood on its last day'}.
        {unsided > 0 &&
          ` Net worth also counts ${unsided} ${unsided === 1 ? 'account' : 'accounts'} in no group yet.`}
      </p>
      <Plot
        box={box}
        width={width}
        count={columns.length}
        plotWidth={plotWidth}
        label={stackedSummary(period, columns, currency)}
        setActive={setActive}
        pickAt={(offset) => Math.floor(offset / step)}
        tooltip={
          shown !== null && active !== null ? (
            <Tooltip left={x(active)} width={width}>
              <strong>{describePeriod(period, shown.from, LOCALE)}</strong>
              {period !== 'day' && (
                <span className="muted">As of {describeDay(shown.day.on_date, LOCALE)}</span>
              )}
              {SIDES.map((side) => (
                <span key={side} className="tooltip-row">
                  <i className={`swatch ${side}`} />
                  {SIDE_NAMES[side]} {sideFigure(shown.day, side, currency)}
                </span>
              ))}
              <span className="tooltip-row">
                Net worth{' '}
                {shown.day.minor === null ? '—' : formatMinor(shown.day.minor, currency, LOCALE)}
              </span>
            </Tooltip>
          ) : null
        }
      >
        <Axes plot={plot} currency={currency} />
        <DateAxis
          ticks={dateTicks(
            axisDates(period, columns, history.days[0]?.on_date),
            labelsAcross(plotWidth),
            period === 'month',
            LOCALE,
          )}
          count={columns.length}
          x={x}
        />
        {shown !== null && active !== null && (
          <rect
            className="column-hover"
            x={x(active) - step / 2}
            width={step}
            y={MARGIN.top}
            height={plotHeight}
          />
        )}
        {columns.map(({ from, day }, index) => (
          <g key={from} className="column">
            {stack(day).map((s) => {
              const top = Math.min(y(s.from), y(s.to));
              return (
                <rect
                  key={s.side}
                  className={`segment ${s.side}`}
                  x={x(index) - barWidth / 2}
                  width={barWidth}
                  y={top}
                  height={Math.max(1, Math.abs(y(s.to) - y(s.from)))}
                />
              );
            })}
          </g>
        ))}
        {netPoints.length > 1 && (
          <polyline className="line net-overlay" points={netPoints.join(' ')} />
        )}
      </Plot>
    </figure>
  );
}

/** A side's figure as a person reads it: debt as owed, like the tile above the chart. */
function sideFigure(day: NetDay, side: Side, currency: string): string {
  const { minor } = day.sides[side];
  if (minor === null) return '—';
  return formatMinor(side === 'debt' ? -minor : minor, currency, LOCALE);
}

function stackedSummary(period: Period, columns: readonly Column[], currency: string): string {
  const first = columns[0];
  const last = columns[columns.length - 1];
  if (first === undefined || last === undefined) return 'Cash, investments, property and debt';
  const end = SIDES.map((side) => `${SIDE_NAMES[side]} ${sideFigure(last.day, side, currency)}`);
  return `Cash, investments, property and debt stacked by ${period}, ${describePeriod(period, first.from, LOCALE)} to ${describePeriod(period, last.from, LOCALE)}. On the last: ${end.join(', ')}. Use the arrow keys to read each ${period}.`;
}

/**
 * Each column's first day, except that the axis starts where the range does: the first week
 * of a year-to-date began on Monday 29 Dec, and the chart opened on "Dec 29, 2025". A month's
 * end label names only the month, so it keeps its 1st.
 */
function axisDates(
  period: Period,
  columns: readonly Column[],
  first: string | undefined,
): string[] {
  const dates = columns.map((column) => column.from);
  if (period !== 'month' && first !== undefined && dates.length > 0) dates[0] = first;
  return dates;
}
