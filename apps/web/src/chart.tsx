import { minorDigits } from '@dinora/core/money';
import type { DateTick } from '@dinora/core/networth';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/*
 * What every chart shares: where things go, the axes, the crosshair read by pointer or arrow
 * keys, and the tooltip. Written for net worth (ACCT-04, UI-07) and taken out for the spending
 * pace (BUD-02), so the two read and move alike.
 */

/** The browser's own: amounts and dates read the way the rest of the device does. */
const LOCALE = undefined;

export const HEIGHT = 220;
export const MARGIN = { top: 20, right: 12, bottom: 26, left: 64 } as const;
/** Before the first measure, and in a test, where nothing has a width. */
const FALLBACK_WIDTH = 640;

export function LineSwatch({ className }: { readonly className: string }) {
  return (
    <svg width="24" height="8">
      <line x1="0" y1="4" x2="24" y2="4" className={className} />
    </svg>
  );
}

/* ─── the frame ─────────────────────────────────────────────────────────────────────────── */

export type Frame = {
  readonly ticks: readonly number[];
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly x: (index: number) => number;
  readonly yDollars: (dollars: number) => number;
  readonly y: (minor: bigint) => number;
};

/**
 * Where things go. Points sit on the plot's edges; columns sit in the middle of equal slots,
 * so the first and last are not cut in half.
 */
export function frame(
  width: number,
  count: number,
  ticks: readonly number[],
  currency: string,
  slots = false,
): Frame {
  const unit = 10 ** (minorDigits(currency) ?? 2);
  const low = ticks[0] ?? 0;
  const high = ticks[ticks.length - 1] ?? 0;
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = slots
    ? (index: number) => MARGIN.left + ((index + 0.5) / Math.max(1, count)) * plotWidth
    : (index: number) =>
        MARGIN.left + (count < 2 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  // Whole dollars in, pixels out. `high === low` only when every value is the same round figure.
  const yDollars = (dollars: number) =>
    MARGIN.top + plotHeight - ((dollars - low) / (high - low || 1)) * plotHeight;
  const y = (minor: bigint) => yDollars(Number(minor) / unit);
  return { ticks, plotWidth, plotHeight, x, yDollars, y };
}

export function Axes({ plot, currency }: { readonly plot: Frame; readonly currency: string }) {
  return plot.ticks.map((tick) => (
    <g key={tick}>
      <line
        className={tick === 0 ? 'axis zero' : 'axis'}
        x1={MARGIN.left}
        x2={MARGIN.left + plot.plotWidth}
        y1={plot.yDollars(tick)}
        y2={plot.yDollars(tick)}
      />
      <text
        className="tick"
        x={MARGIN.left - 8}
        y={plot.yDollars(tick)}
        dy="0.32em"
        textAnchor="end"
      >
        {compactDollars(tick, currency)}
      </text>
    </g>
  ));
}

/** The svg, read by pointer or by arrow keys, one index at a time. */
export function Plot({
  box,
  width,
  count,
  plotWidth,
  label,
  setActive,
  pickAt,
  readable = [0, count - 1],
  tooltip,
  children,
}: {
  readonly box: (element: HTMLDivElement | null) => void;
  readonly width: number;
  readonly count: number;
  readonly plotWidth: number;
  readonly label: string;
  readonly setActive: (update: (current: number | null) => number | null) => void;
  /** Pixels from the plot's left edge to an index, before it is clamped. */
  readonly pickAt: (offset: number) => number;
  /**
   * The first and last index a reader can land on, when not every one drawn is: the pace's
   * start of the month is drawn but is no day, and a running month's days after today are laid
   * out but hold nothing yet.
   */
  readonly readable?: readonly [number, number];
  readonly tooltip: ReactNode;
  readonly children: ReactNode;
}) {
  const [first, last] = readable;
  const clamp = (index: number) => Math.min(last, Math.max(first, index));

  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (event.key === 'Home') setActive(() => first);
    else if (event.key === 'End') setActive(() => last);
    else if (event.key in step) {
      setActive((current) => clamp((current ?? last) + (step[event.key] ?? 0)));
    } else return;
    event.preventDefault();
  };

  return (
    <div className="chart-plot" ref={box}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((current) => current ?? last)}
        onBlur={() => setActive(() => null)}
        onPointerMove={(event: PointerEvent<SVGSVGElement>) => {
          const left = event.currentTarget.getBoundingClientRect().left;
          const offset = Math.min(plotWidth, event.clientX - left - MARGIN.left);
          setActive(() => clamp(pickAt(offset)));
        }}
        onPointerLeave={() => setActive(() => null)}
      >
        {children}
      </svg>
      {tooltip}
    </div>
  );
}

export function Tooltip({
  left,
  width,
  children,
}: {
  readonly left: number;
  readonly width: number;
  readonly children: ReactNode;
}) {
  return (
    <div className="tooltip small" style={{ left: Math.min(Math.max(left, 90), width - 90) }}>
      {children}
    </div>
  );
}

/**
 * The table scrolls inside itself, never the page (UI-01). The stacked table has six columns,
 * 511px against a phone's 358px, and with nothing around it to scroll the whole page grew to
 * 527px and cut off Debt owed and Net worth (measured at 390px, 26 Sep). Focusable, so a
 * keyboard can scroll it too.
 */
export function TableScroll({ children }: { readonly children: ReactNode }) {
  return (
    <div className="table-scroll" role="region" aria-label="The chart as a table" tabIndex={0}>
      {children}
    </div>
  );
}

export function compactDollars(dollars: number, currency: string): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(dollars);
}

/** A month's label is about 30px at 12px type; 56 leaves the gap that makes it one. */
export function labelsAcross(plotWidth: number): number {
  return Math.max(2, Math.floor(plotWidth / 56));
}

/** The dates under the plot, both charts the same way (UI-07). The ends hang inward. */
export function DateAxis({
  ticks,
  count,
  x,
}: {
  readonly ticks: readonly DateTick[];
  readonly count: number;
  readonly x: (index: number) => number;
}) {
  return ticks.map(({ index, label }) => (
    <text
      key={index}
      className="tick date"
      x={x(index)}
      y={HEIGHT - 6}
      textAnchor={index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'}
    >
      {label}
    </text>
  ));
}

/** The element's width, followed as it changes: the chart is drawn to it, not scaled. */
export function useWidth(): [(element: HTMLDivElement | null) => void, number] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const measured = element.clientWidth;
      if (measured > 0) setWidth(measured);
    };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
    return () => observer.current?.disconnect();
  }, [element]);
  return [setElement, width];
}
