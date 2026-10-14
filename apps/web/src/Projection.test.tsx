import type { Side } from '@dinora/core/groups';
import type { SnapshotRow } from '@dinora/core/history';
import { netWorthByDay } from '@dinora/core/networth';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { History } from './NetWorthChart.tsx';
import { wholeUnits } from './Projection.tsx';

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function snap(
  accountId: string,
  onDate: string,
  minor: number,
  kind: SnapshotRow['kind'],
): SnapshotRow {
  return {
    id: `${accountId}-${onDate}`,
    updated_at: '2026-09-26T09:00:00+00:00',
    deleted_at: null,
    account_id: accountId,
    on_date: onDate,
    kind,
    currency: 'USD',
    balance_minor: minor,
    as_of: `${onDate}T09:00:00+00:00`,
  };
}

/**
 * A row every 26th from `from` to 26 Sep 2026, moving by `step` each month from `base`, the
 * ones before 2026 Monarch's.
 */
function monthly(accountId: string, from: string, base: number, step: number): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  let minor = base;
  for (let on = from; on <= '2026-09-26'; on = addDays(on, 1)) {
    if (on.endsWith('-26')) {
      rows.push(snap(accountId, on, minor, on < '2026-01-01' ? 'monarch' : 'read'));
      minor += step;
    }
  }
  return rows;
}

// Savings up $500 a month, the car loan down $400: a year and a half of each.
const SNAPSHOTS = [
  ...monthly('sav', '2025-03-26', 1_000_000, 50_000),
  ...monthly('car', '2025-03-26', -2_000_000, 40_000),
];

const SIDES = new Map<string, Side | null>([
  ['sav', 'cash'],
  ['car', 'debt'],
]);

function text(element: Element = document.body): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ');
}

describe('the net worth chart, projected', () => {
  const tip = () => text(document.querySelector('.tooltip') ?? document.body);

  // Nora, 27 Sep 2026: on its own chart, which way it was going was too hard to see.
  it('draws net worth on into the year ahead, on the same chart, with nothing said under it', () => {
    render(<History history={netWorthByDay(SNAPSHOTS, SIDES, [])} />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    const chart = () => screen.getByRole('img', { name: /^Net worth by day/ });
    expect(chart().getAttribute('aria-label')).toContain('projected to about $17,000 by Sep 2027');
    expect(document.querySelectorAll('polyline.line.net.projected')).toHaveLength(1);
    // What it assumes was a paragraph she did not read.
    expect(text()).not.toContain('A guess, not a forecast');
    expect(text()).not.toContain('Drawn from');
    fireEvent.click(screen.getByLabelText('Five years ahead'));
    expect(chart().getAttribute('aria-label')).toContain('by Sep 2031');
  });

  it('keeps what is owed at nothing once a debt is paid off', () => {
    render(<History history={netWorthByDay(SNAPSHOTS, SIDES, [])} />);
    fireEvent.click(screen.getByLabelText('Debt owed'));
    fireEvent.click(screen.getByLabelText('Five years ahead'));
    const chart = screen.getByRole('img', { name: /^Debt owed by day/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: 'End' });
    expect(tip()).toContain('About $0');
  });

  it('reads a month ahead with its likely range, and a day behind as it was', () => {
    const rows = [
      ...monthly('sav', '2025-03-26', 1_000_000, 50_000),
      ...monthly('ira', '2025-09-26', 5_000_000, 0).map((row, index) => ({
        ...row,
        balance_minor: row.balance_minor + (index % 2 === 0 ? 0 : 300_000),
      })),
    ];
    const sides = new Map<string, Side | null>([
      ['sav', 'cash'],
      ['ira', 'investments'],
    ]);
    render(<History history={netWorthByDay(rows, sides, [])} />);
    fireEvent.click(screen.getByLabelText('Investments'));
    expect(document.querySelector('polygon.band.investments')).not.toBeNull();
    const chart = screen.getByRole('img', { name: /^Investments by day/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: 'End' });
    expect(tip()).toContain('projected');
    expect(tip()).toContain('Likely');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(tip()).not.toContain('Likely');
  });

  it('draws no line ahead while the history is too short for one', () => {
    const rows = [
      ...monthly('sav', '2025-03-26', 1_000_000, 50_000),
      ...monthly('car', '2026-08-26', -2_000_000, 40_000),
    ];
    render(<History history={netWorthByDay(rows, SIDES, [])} />);
    expect(document.querySelector('polyline.projected')).toBeNull();
    expect(text()).not.toContain('Too soon to project');
  });

  it('says so when no account counts toward a side', () => {
    render(<History history={netWorthByDay(SNAPSHOTS, SIDES, [])} />);
    fireEvent.click(screen.getByLabelText('Investments'));
    expect(text()).toContain('No account counts as investments yet.');
  });
});

describe('whole units', () => {
  it('rounds half away from zero', () => {
    expect(wholeUnits(123_450n, 'USD')).toBe('$1,235');
    expect(wholeUnits(123_449n, 'USD')).toBe('$1,234');
    expect(wholeUnits(-123_450n, 'USD')).toBe('-$1,235');
    expect(wholeUnits(1_234n, 'JPY')).toBe('¥1,234');
  });
});
