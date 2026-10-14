import type { Month } from '@dinora/core/budgets';
import { entriesIn, firstDayOf, lastDayOf, shiftMonth } from '@dinora/core/budgets';
import { axisTicks, describeShortDay } from '@dinora/core/networth';
import type { Standing } from '@dinora/core/pace';
import { evenPace, laidAlong, spentByDay } from '@dinora/core/pace';
import { useState } from 'react';

import type { BudgetMonth } from './Budget.tsx';
import { money } from './Budget.tsx';
import {
  Axes,
  DateAxis,
  frame,
  labelsAcross,
  LineSwatch,
  MARGIN,
  Plot,
  TableScroll,
  Tooltip,
  useWidth,
} from './chart.tsx';
import { LOCALE } from './time.tsx';

/*
 * The month's spending by day against an even pace to its budget, last month faint behind it
 * (BUD-02). It takes the place of the month's one bar, which drew 60% spent on the 10th the same
 * as on the 28th: a line above the straight one is spending faster than the month is going, and
 * how far above, since when, says by how much.
 *
 * Index n is the end of day n, and index 0 the month's start, at nothing, so the pace is a
 * straight line from the corner. Index 0 is drawn but not read: it is no day.
 */

type Point = readonly [index: number, minor: bigint];

export function SpendingPace({
  data,
  budgetedMinor,
  standing,
}: {
  readonly data: BudgetMonth;
  /** Null with no budget this month: the line is drawn against last month alone. */
  readonly budgetedMinor: bigint | null;
  readonly standing: Standing | null;
}) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { month, summary, history } = data;
  const { currency } = summary;
  const days = Number(lastDayOf(month).slice(8));

  const spent = spentByDay(month, data.entries, data.categories, history.rates, history.today);
  const before = shiftMonth(month, -1);
  const beforeEntries = entriesIn(
    before,
    history.transactions,
    history.counted,
    history.file,
    history.today,
  );
  // A month with nothing read in it is not one that spent nothing: the history starts later.
  const lastMonth =
    beforeEntries.length === 0
      ? null
      : laidAlong(
          spentByDay(before, beforeEntries, data.categories, history.rates, history.today),
          days,
        );
  const beforeDays = Number(lastDayOf(before).slice(8));
  const pace = (n: number) => (budgetedMinor === null ? null : evenPace(budgetedMinor, n, days));

  const through = spent.length - 1;
  if (through < 1) return null;

  const values = [
    0n,
    ...(budgetedMinor === null ? [] : [budgetedMinor]),
    ...spent.flatMap((v) => (v === null ? [] : [v])),
    ...(lastMonth ?? []).flatMap((v) => (v === null ? [] : [v])),
  ];
  const count = days + 1;
  const plot = frame(width, count, axisTicks(values, currency), currency);
  const { x, y, plotWidth, plotHeight } = plot;
  const dayOn = (n: number) => `${month}-${String(n).padStart(2, '0')}`;
  const shown = active === null ? null : spent[active];
  const lastName = monthName(before);

  const lastMonthAt = (n: number) =>
    n >= beforeDays || n === days
      ? `All of ${lastName}`
      : `${lastName} by ${describeShortDay(`${before}-${String(n).padStart(2, '0')}`, LOCALE)}`;

  return (
    <figure className="chart pace-chart">
      <div className="chart-key small muted" aria-hidden="true">
        <span>
          <LineSwatch className={`line spent ${standing ?? ''}`} />
          Spent
        </span>
        {budgetedMinor !== null && (
          <span>
            <LineSwatch className="line pace" />
            Even pace to {money(budgetedMinor, currency)}
          </span>
        )}
        {lastMonth !== null && (
          <span>
            <LineSwatch className="line last-month" />
            {lastName}
          </span>
        )}
      </div>
      <Plot
        box={box}
        width={width}
        count={count}
        plotWidth={plotWidth}
        label={describe(
          month,
          spent,
          budgetedMinor,
          lastMonth === null ? null : { name: lastName, line: lastMonth },
          currency,
        )}
        setActive={setActive}
        pickAt={(offset) => Math.round((offset / plotWidth) * days)}
        readable={[1, through]}
        tooltip={
          active !== null && shown !== undefined ? (
            <Tooltip left={x(active)} width={width}>
              <strong>{shown === null ? 'Not worked out' : money(shown, currency)}</strong>
              <span className="muted">spent by {describeShortDay(dayOn(active), LOCALE)}</span>
              {budgetedMinor !== null && (
                <span className="muted">Even pace {money(pace(active) ?? 0n, currency)}</span>
              )}
              {lastMonth !== null && (
                <span className="muted">
                  {lastMonthAt(active)} {figure(lastMonth[active], currency)}
                </span>
              )}
            </Tooltip>
          ) : null
        }
      >
        <Axes plot={plot} currency={currency} />
        <DateAxis ticks={dayTicks(days, plotWidth, dayOn)} count={count} x={x} />
        {lastMonth !== null &&
          runs(lastMonth).map((run) => (
            <polyline key={run[0]?.[0]} className="line last-month" points={at(run, x, y)} />
          ))}
        {budgetedMinor !== null && (
          <line className="line pace" x1={x(0)} y1={y(0n)} x2={x(days)} y2={y(budgetedMinor)} />
        )}
        {runs(spent).map((run) => (
          <polyline
            key={run[0]?.[0]}
            className={`line spent ${standing ?? ''}`}
            points={at(run, x, y)}
          />
        ))}
        {active !== null && (
          <g className="crosshair">
            <line x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />
            {shown !== null && shown !== undefined && (
              <circle className={`spent ${standing ?? ''}`} cx={x(active)} cy={y(shown)} r={4} />
            )}
          </g>
        )}
      </Plot>
      <details className="chart-table small">
        <summary>Show as a table</summary>
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Spent by then</th>
                {budgetedMinor !== null && <th scope="col">Even pace</th>}
                {lastMonth !== null && <th scope="col">{lastName}</th>}
              </tr>
            </thead>
            <tbody>
              {spent
                .map((minor, n) => ({ minor, n }))
                .slice(1)
                .reverse()
                .map(({ minor, n }) => (
                  <tr key={n}>
                    <td>
                      <time dateTime={dayOn(n)}>{describeShortDay(dayOn(n), LOCALE)}</time>
                    </td>
                    <td className="amount">{figure(minor, currency)}</td>
                    {budgetedMinor !== null && (
                      <td className="amount">{figure(pace(n), currency)}</td>
                    )}
                    {lastMonth !== null && (
                      <td className="amount">{figure(lastMonth[n], currency)}</td>
                    )}
                  </tr>
                ))}
            </tbody>
          </table>
        </TableScroll>
      </details>
    </figure>
  );
}

function figure(minor: bigint | null | undefined, currency: string): string {
  return minor === null || minor === undefined ? '—' : money(minor, currency);
}

function monthName(month: Month): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: 'UTC' }).format(
    Date.parse(`${firstDayOf(month)}T00:00:00Z`),
  );
}

/** The line as runs of days with a figure: a day with no rate breaks it rather than dips. */
function runs(line: readonly (bigint | null)[]): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  for (const [index, minor] of line.entries()) {
    if (minor === null) {
      if (run.length > 0) out.push(run);
      run = [];
    } else run.push([index, minor]);
  }
  if (run.length > 0) out.push(run);
  return out;
}

function at(run: readonly Point[], x: (i: number) => number, y: (m: bigint) => number): string {
  return run.map(([index, minor]) => `${x(index)},${y(minor)}`).join(' ');
}

/**
 * The 1st, the last, and a week apart between where they fit; the 1st, the 15th and the last on
 * a phone. At a 390px phone's 282px plot the weekly five fit by the axis's own measure, but the
 * last hangs inward and left "Sep 22" 9px from "Sep 30" (measured 26 Sep), so weekly wants room
 * for six. The 22nd is dropped when it would crowd a 28-day month's end.
 */
function dayTicks(days: number, plotWidth: number, dayOn: (n: number) => string) {
  const weekly = labelsAcross(plotWidth) >= 6;
  const picked = weekly
    ? [1, 8, 15, 22, days].filter((n, i, all) => i === all.length - 1 || days - n >= 5)
    : [1, 15, days];
  return picked.map((n) => ({ index: n, label: describeShortDay(dayOn(n), LOCALE) }));
}

function describe(
  month: Month,
  spent: readonly (bigint | null)[],
  budgetedMinor: bigint | null,
  last: { readonly name: string; readonly line: readonly (bigint | null)[] } | null,
  currency: string,
): string {
  const through = spent.length - 1;
  const today = spent[through];
  const on = describeShortDay(`${month}-${String(through).padStart(2, '0')}`, LOCALE);
  const parts = [`Spent by day, ${figure(today, currency)} by ${on}`];
  const days = Number(lastDayOf(month).slice(8));
  if (budgetedMinor !== null) {
    parts.push(`an even pace would be ${money(evenPace(budgetedMinor, through, days), currency)}`);
  }
  if (last !== null) parts.push(`${last.name} had spent ${figure(last.line[through], currency)}`);
  return `${parts.join('; ')}. Use the arrow keys to read each day.`;
}
