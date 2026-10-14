import { minorDigits } from '@dinora/core/money';
import type { DayKind } from '@dinora/core/networth';
import { axisTicks, dateTicks, describeDay, lessSure } from '@dinora/core/networth';
import type { AheadPoint, PastPoint } from '@dinora/core/projection';
import { addDays } from '@dinora/core/projection';
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
  TableScroll,
  Tooltip,
  useWidth,
} from './chart.tsx';
import { LOCALE } from './time.tsx';

/*
 * Where a balance is heading (GOAL-02). A projection is a guess and renders as one: the line
 * ahead is broken and the band around it widens. The model and its reasons are in
 * packages/core/src/projection.ts. On the dashboard it is drawn on the end of the net worth
 * line with no words under it (Nora, 27 Sep 2026: the pace, the spread and the days it was
 * drawn from were a paragraph she did not read); a goal's page uses the chart here.
 *
 * Figures ahead are whole dollars: a balance in 2031 to the cent claims a precision nobody has.
 * They are rounded from integer minor units, never from a float (invariant 1).
 */

const KNOWN: Readonly<Record<DayKind, string>> = {
  read: 'Read from the bank',
  monarch: 'Kept by Monarch',
  statement: 'From the lender’s statement',
  rebuilt: 'Rebuilt from transactions',
};

/** A figure in whole units of its currency, rounded half away from zero. */
export function wholeUnits(minor: bigint, currency: string): string {
  const unit = 10n ** BigInt(minorDigits(currency) ?? 2);
  const half = unit / 2n;
  const whole = minor < 0n ? -((-minor + half) / unit) : (minor + half) / unit;
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number(whole));
}

export function describeMonth(on: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.parse(`${on}T00:00:00Z`));
}

/* ─── the chart ─────────────────────────────────────────────────────────────────────────── */

type Read =
  | { readonly kind: 'past'; readonly point: PastPoint }
  | { readonly kind: 'ahead'; readonly point: AheadPoint };

/**
 * Past points solid, drawn as the net worth line is (Monarch's fainter, rebuilt broken), and
 * the line ahead broken inside its band. Dates are spaced by days, not by points: a goal's
 * months behind and its one finish years ahead sit where they fall in time.
 */
export function ProjectionChart({
  past,
  ahead,
  series,
  currency,
  label,
  line,
  marker,
}: {
  readonly past: readonly PastPoint[];
  readonly ahead: readonly AheadPoint[];
  /** The side's colour class, or none for net worth's own. */
  readonly series: string;
  readonly currency: string;
  readonly label: string;
  /** A level it is heading for, drawn across: a saving's target. */
  readonly line?: { readonly minor: bigint; readonly label: string };
  /** A day marked down the chart: the day a goal is to be reached by. */
  readonly marker?: { readonly on: string; readonly label: string };
}) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const first = past[0];
  const now = past[past.length - 1];
  if (first === undefined || now === undefined) return null;

  const reads: Read[] = [
    ...past.map((point) => ({ kind: 'past' as const, point })),
    ...ahead.map((point) => ({ kind: 'ahead' as const, point })),
  ];
  const lastOn = [now.on, ahead[ahead.length - 1]?.on ?? now.on, marker?.on ?? now.on].reduce(
    (a, b) => (a > b ? a : b),
  );
  const days = Math.max(1, daysBetween(first.on, lastOn));
  const values = [
    ...past.map((p) => p.minor),
    ...ahead.flatMap((p) => [p.lowMinor, p.highMinor]),
    ...(line === undefined ? [] : [line.minor]),
  ];
  const plot = frame(width, days + 1, axisTicks(values, currency), currency);
  const { y, plotWidth, plotHeight } = plot;
  const xOn = (on: string) => plot.x(daysBetween(first.on, on));
  const xAt = (index: number) => xOn(reads[index]?.point.on ?? now.on);

  // Every day, so an index is a distance in time and `dateTicks` keeps its labels a gap apart.
  // Month-ends with an odd last day put "Jan 2031" on top of "Sep 26, 2031" (seen at 1000px).
  const axisDates = Array.from({ length: days + 1 }, (_, day) => addDays(first.on, day));

  const pickAt = (offset: number) => {
    const day = (offset / plotWidth) * days;
    let best = 0;
    for (const [index, read] of reads.entries()) {
      const here = Math.abs(daysBetween(first.on, read.point.on) - day);
      const there = Math.abs(daysBetween(first.on, reads[best]?.point.on ?? first.on) - day);
      if (here < there) best = index;
    }
    return best;
  };

  const shown = active === null ? null : (reads[active] ?? null);
  const band =
    ahead.length === 0
      ? null
      : [
          `${xOn(now.on)},${y(now.minor)}`,
          ...ahead.map((p) => `${xOn(p.on)},${y(p.highMinor)}`),
          ...[...ahead].reverse().map((p) => `${xOn(p.on)},${y(p.lowMinor)}`),
        ].join(' ');
  const hasBand = ahead.some((p) => p.highMinor !== p.lowMinor);

  return (
    <figure className="chart projection">
      <div className="chart-key small muted" aria-hidden="true">
        <span>
          <LineSwatch className={`line ${series} read`} />
          So far
        </span>
        {ahead.length > 0 && (
          <span>
            <LineSwatch className={`line ${series} projected`} />
            Projected{hasBand ? ', with its likely range' : ''}
          </span>
        )}
      </div>
      <Plot
        box={box}
        width={width}
        count={reads.length}
        plotWidth={plotWidth}
        label={label}
        setActive={setActive}
        pickAt={pickAt}
        readable={[0, reads.length - 1]}
        tooltip={
          shown !== null && active !== null ? (
            <Tooltip left={xAt(active)} width={width}>
              {shown.kind === 'past' ? (
                <>
                  <strong>{wholeUnits(shown.point.minor, currency)}</strong>
                  <span className="muted">{describeDay(shown.point.on, LOCALE)}</span>
                  <span className="muted">{KNOWN[shown.point.kind]}</span>
                </>
              ) : (
                <>
                  <strong>About {wholeUnits(shown.point.minor, currency)}</strong>
                  <span className="muted">{describeMonth(shown.point.on)}, projected</span>
                  {shown.point.highMinor !== shown.point.lowMinor && (
                    <span className="muted">
                      Likely {wholeUnits(shown.point.lowMinor, currency)} to{' '}
                      {wholeUnits(shown.point.highMinor, currency)}
                    </span>
                  )}
                </>
              )}
            </Tooltip>
          ) : null
        }
      >
        <Axes plot={plot} currency={currency} />
        <DateAxis
          ticks={dateTicks(axisDates, labelsAcross(plotWidth), false, LOCALE)}
          count={axisDates.length}
          x={(index) => xOn(axisDates[index] ?? first.on)}
        />
        {line !== undefined && (
          <g className="level">
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={y(line.minor)}
              y2={y(line.minor)}
            />
            <text x={MARGIN.left + 4} y={y(line.minor) - 6}>
              {line.label}
            </text>
          </g>
        )}
        {marker !== undefined && (
          <g className="marker">
            <line
              x1={xOn(marker.on)}
              x2={xOn(marker.on)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotHeight}
            />
            <text x={xOn(marker.on)} y={MARGIN.top - 6} textAnchor="end">
              {marker.label}
            </text>
          </g>
        )}
        {band !== null && hasBand && <polygon className={`band ${series}`} points={band} />}
        {runs(past).map((run) => (
          <polyline
            key={run.from}
            className={`line ${series} ${run.kind}`}
            points={run.points.map((p) => `${xOn(p.on)},${y(p.minor)}`).join(' ')}
          />
        ))}
        {ahead.length > 0 && (
          <polyline
            className={`line ${series} projected`}
            points={[now, ...ahead].map((p) => `${xOn(p.on)},${y(p.minor)}`).join(' ')}
          />
        )}
        {shown !== null && active !== null && (
          <g className="crosshair">
            <line x1={xAt(active)} x2={xAt(active)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />
            <circle className={series} cx={xAt(active)} cy={y(shown.point.minor)} r={4} />
          </g>
        )}
      </Plot>
      <details className="chart-table small">
        <summary>Show as a table</summary>
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Figure</th>
                <th scope="col">How it is known</th>
              </tr>
            </thead>
            <tbody>
              {[...reads].reverse().map((read) => (
                <tr key={`${read.kind}-${read.point.on}`}>
                  <td>
                    <time dateTime={read.point.on}>
                      {read.kind === 'past'
                        ? describeDay(read.point.on, LOCALE)
                        : describeMonth(read.point.on)}
                    </time>
                  </td>
                  <td className="amount">
                    {read.kind === 'ahead' && 'About '}
                    {wholeUnits(read.point.minor, currency)}
                  </td>
                  <td>
                    {read.kind === 'past'
                      ? KNOWN[read.point.kind]
                      : read.point.highMinor === read.point.lowMinor
                        ? 'Projected'
                        : `Projected, likely ${wholeUnits(read.point.lowMinor, currency)} to ${wholeUnits(read.point.highMinor, currency)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </details>
    </figure>
  );
}

type Run = { readonly from: number; readonly kind: DayKind; readonly points: PastPoint[] };

/** The past as runs of one kind, each step drawn as the less sure of its ends. */
function runs(past: readonly PastPoint[]): Run[] {
  const out: Run[] = [];
  for (const [index, point] of past.entries()) {
    const before = past[index - 1];
    if (before === undefined) {
      if (past.length === 1) out.push({ from: 0, kind: point.kind, points: [point] });
      continue;
    }
    const kind = lessSure(before.kind, point.kind);
    const run = out[out.length - 1];
    if (run !== undefined && run.kind === kind) run.points.push(point);
    else out.push({ from: index - 1, kind, points: [before, point] });
  }
  return out;
}
