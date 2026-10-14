import { describe, expect, it } from 'vitest';

import type { AccountRow } from './balances.ts';
import type { GoalAccountRow, GoalRow } from './goals.ts';
import { progressOf } from './goals.ts';
import type { SnapshotRow } from './history.ts';
import type { NetDay, NetHistory, SidePoint } from './networth.ts';
import type { SeriesDay } from './projection.ts';
import {
  addDays as nextDays,
  goalPath,
  isqrt,
  monthsBetween,
  monthsFrom,
  project,
  PROJECTION_MIN_MONTHS,
  seriesOf,
} from './projection.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A day for every date from `from` to `to`, its figure from `figure`. */
function daily(
  from: string,
  to: string,
  figure: (on: string) => bigint | null,
  extra: (on: string) => Partial<SeriesDay> = () => ({}),
): SeriesDay[] {
  const days: SeriesDay[] = [];
  for (let on = from; on <= to; on = addDays(on, 1)) {
    days.push({ on_date: on, minor: figure(on), kind: 'read', whole: true, ...extra(on) });
  }
  return days;
}

/** The figure rises by `perMonth` at each 26th, from `base` on 26 Sep 2025. */
function stepping(base: bigint, perMonth: (month: number) => bigint) {
  return (on: string): bigint => {
    let minor = base;
    for (let month = 1; monthsFrom('2025-09-26', month) <= on; month += 1) {
      minor += perMonth(month);
    }
    return minor;
  };
}

describe('monthsFrom', () => {
  it('keeps to the end of a shorter month, forward and back', () => {
    expect(monthsFrom('2026-03-31', -1)).toBe('2026-02-28');
    expect(monthsFrom('2026-01-31', 1)).toBe('2026-02-28');
    expect(monthsFrom('2024-03-31', -1)).toBe('2024-02-29');
    expect(monthsFrom('2026-09-26', -12)).toBe('2025-09-26');
    expect(monthsFrom('2026-09-26', 120)).toBe('2036-09-26');
  });
});

describe('addDays', () => {
  it('crosses months and years, both ways', () => {
    expect(nextDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(nextDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('monthsBetween', () => {
  it('counts whole months only', () => {
    expect(monthsBetween('2026-01-25', '2026-02-24')).toBe(0);
    expect(monthsBetween('2026-01-25', '2026-02-25')).toBe(1);
    expect(monthsBetween('2024-04-16', '2026-09-26')).toBe(29);
    expect(monthsBetween('2026-09-26', '2026-09-01')).toBe(0);
    expect(monthsBetween('2026-01-31', '2026-02-28')).toBe(1);
  });
});

describe('isqrt', () => {
  it('is the floor of the root', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(-4n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    expect(isqrt(10n ** 30n)).toBe(10n ** 15n);
    expect(isqrt(10n ** 30n - 1n)).toBe(10n ** 15n - 1n);
  });
});

describe('project', () => {
  it('has nothing to say about nothing', () => {
    expect(project([], 12)).toEqual({ kind: 'empty' });
  });

  it('goes on at a steady pace with no band when every month moved the same', () => {
    const days = daily(
      '2025-09-26',
      '2026-09-26',
      stepping(1_000_000n, () => 50_000n),
    );
    const projection = project(days, 24);
    expect(projection.kind).toBe('projected');
    if (projection.kind !== 'projected') return;
    expect(projection.months).toBe(12);
    expect(projection.past).toHaveLength(13);
    expect(projection.past[0]).toEqual({ on: '2025-09-26', minor: 1_000_000n, kind: 'read' });
    expect(projection.past[12]?.minor).toBe(1_600_000n);
    expect(projection.perMonthMinor).toBe(50_000n);
    expect(projection.spreadMinor).toBe(0n);
    expect(projection.ahead).toHaveLength(24);
    expect(projection.ahead[0]).toEqual({
      on: '2026-10-26',
      minor: 1_650_000n,
      lowMinor: 1_650_000n,
      highMinor: 1_650_000n,
    });
    expect(projection.ahead[23]?.on).toBe('2028-09-26');
    expect(projection.ahead[23]?.minor).toBe(2_800_000n);
    expect(projection.clearsOn).toBeNull();
  });

  it('widens the band with the square root of the months ahead', () => {
    // Alternating +100 and −50 dollars: a mean of 25 a month, and months unlike each other.
    const days = daily(
      '2025-09-26',
      '2026-09-26',
      stepping(0n, (month) => (month % 2 === 1 ? 10_000n : -5_000n)),
    );
    const projection = project(days, 60);
    if (projection.kind !== 'projected') throw new Error(projection.kind);
    expect(projection.perMonthMinor).toBe(2_500n);
    // Six of +10,000 and six of −5,000 about a mean of 2,500: variance 7,500² × 12/11.
    const variance = (7_500n * 7_500n * 12n) / 11n;
    expect(projection.spreadMinor).toBe(isqrt(variance));
    const one = projection.ahead[0];
    const four = projection.ahead[3];
    if (one === undefined || four === undefined) throw new Error('short');
    expect(one.highMinor - one.minor).toBe(isqrt(variance));
    expect(four.highMinor - four.minor).toBe(isqrt(variance * 4n));
    expect(four.minor - four.lowMinor).toBe(four.highMinor - four.minor);
  });

  it('stops the window at the first month-end before every account had joined', () => {
    const days = daily(
      '2025-09-26',
      '2026-09-26',
      stepping(0n, () => 1_000n),
      (on) => ({ whole: on >= '2026-04-01' }),
    );
    const projection = project(days, 12);
    if (projection.kind !== 'projected') throw new Error(projection.kind);
    expect(projection.months).toBe(5);
    expect(projection.past[0]?.on).toBe('2026-04-26');
  });

  it('stops it at a day with no rate, or a day the history does not have', () => {
    const unrated = daily('2025-09-26', '2026-09-26', (on) => (on === '2026-05-26' ? null : 100n));
    const projection = project(unrated, 12);
    if (projection.kind !== 'projected') throw new Error(projection.kind);
    expect(projection.months).toBe(3);
    expect(projection.perMonthMinor).toBe(0n);

    const young = daily('2026-08-01', '2026-09-26', () => 100n);
    expect(project(young, 12)).toEqual({ kind: 'too-short', months: 1, since: '2026-08-26' });
  });

  it('is too short under three months, and says since when', () => {
    const days = daily('2026-06-27', '2026-09-26', () => 100n);
    expect(PROJECTION_MIN_MONTHS).toBe(3);
    expect(project(days, 12)).toEqual({ kind: 'too-short', months: 2, since: '2026-07-26' });
    const unwhole = daily(
      '2026-09-01',
      '2026-09-26',
      () => 100n,
      () => ({ whole: false }),
    );
    expect(project(unwhole, 12)).toEqual({ kind: 'too-short', months: 0, since: null });
  });

  it('is only as sure as the least sure day in its window', () => {
    const days = daily(
      '2025-06-01',
      '2026-09-26',
      () => 100n,
      (on) => ({
        kind: on < '2025-09-26' ? 'rebuilt' : on < '2026-01-10' ? 'monarch' : 'read',
      }),
    );
    const projection = project(days, 12);
    if (projection.kind !== 'projected') throw new Error(projection.kind);
    expect(projection.sureness).toBe('monarch');
  });

  it('keeps what is owed at nothing or above, and says when it clears', () => {
    const days = daily(
      '2025-09-26',
      '2026-09-26',
      stepping(1_300_000n, () => -100_000n),
    );
    const projection = project(days, 12, true);
    if (projection.kind !== 'projected') throw new Error(projection.kind);
    expect(projection.past[12]?.minor).toBe(100_000n);
    expect(projection.clearsOn).toBe('2026-10-26');
    expect(projection.ahead[0]?.minor).toBe(0n);
    expect(projection.ahead[5]).toEqual({
      on: '2027-03-26',
      minor: 0n,
      lowMinor: 0n,
      highMinor: 0n,
    });
    // Not owed, the same series goes on below zero.
    const signed = project(days, 12);
    if (signed.kind !== 'projected') throw new Error(signed.kind);
    expect(signed.ahead[5]?.minor).toBe(-500_000n);
    expect(signed.clearsOn).toBeNull();
  });
});

describe('seriesOf', () => {
  const side = (minor: bigint | null, counted = 1): SidePoint => ({
    minor,
    kind: 'read',
    counted,
  });
  const day = (onDate: string, counted: number, debt: bigint | null): NetDay => ({
    on_date: onDate,
    minor: 500n,
    kind: 'monarch',
    counted,
    sides: {
      cash: side(700n),
      investments: side(0n, 0),
      property: side(null, 0),
      debt: side(debt, counted - 1),
    },
  });
  const history: NetHistory = {
    currency: 'USD',
    days: [day('2026-09-25', 1, null), day('2026-09-26', 2, -200n)],
    accounts: 2,
    sideAccounts: { cash: 1, investments: 0, property: 0, debt: 1 },
    firstRead: null,
    readDays: 0,
    monarchDays: 2,
    statementDays: 0,
    rebuiltDays: 0,
  };

  it('takes the net, with whether the day counted every account', () => {
    expect(seriesOf(history, 'net')).toEqual([
      { on_date: '2026-09-25', minor: 500n, kind: 'monarch', whole: false },
      { on_date: '2026-09-26', minor: 500n, kind: 'monarch', whole: true },
    ]);
  });

  it('turns debt round to what is owed', () => {
    expect(seriesOf(history, 'debt')).toEqual([
      { on_date: '2026-09-25', minor: null, kind: 'read', whole: false },
      { on_date: '2026-09-26', minor: 200n, kind: 'read', whole: true },
    ]);
    expect(seriesOf(history, 'cash')[1]?.minor).toBe(700n);
  });
});

/* ─── a goal's path ─────────────────────────────────────────────────────────────────────── */

const TODAY = '2026-09-26';

function account(id: string, minor: number): AccountRow {
  return {
    id,
    updated_at: '2026-09-26T09:00:00+00:00',
    deleted_at: null,
    institution: 'PSCU',
    name: id,
    currency: 'USD',
    balance_minor: minor,
    balance_at: '2026-09-26T09:00:00+00:00',
    holdings: 0,
    source: 'simplefin',
  };
}

function snap(accountId: string, onDate: string, minor: number): SnapshotRow {
  return {
    id: `${accountId}-${onDate}`,
    updated_at: '2026-09-26T09:00:00+00:00',
    deleted_at: null,
    account_id: accountId,
    on_date: onDate,
    kind: onDate < '2026-06-01' ? 'monarch' : 'read',
    currency: 'USD',
    balance_minor: minor,
    as_of: `${onDate}T09:00:00+00:00`,
  };
}

function goal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: 'g1',
    updated_at: '2026-09-26T09:00:00+00:00',
    deleted_at: null,
    name: 'Emergency fund',
    kind: 'save',
    currency: 'USD',
    target_minor: 2_000_000,
    starts_on: '2026-05-10',
    target_on: null,
    created_at: '2026-05-10T09:00:00+00:00',
    ...overrides,
  };
}

const link = (accountId: string): GoalAccountRow => ({
  id: `l-${accountId}`,
  updated_at: '2026-09-26T09:00:00+00:00',
  deleted_at: null,
  goal_id: 'g1',
  account_id: accountId,
});

/** A row on the 1st of each month from May, rising by `step` from `base`. */
function monthly(accountId: string, base: number, step: number): SnapshotRow[] {
  return ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map((on, i) =>
    snap(accountId, on, base + step * i),
  );
}

function pathOf(
  row: GoalRow,
  accounts: readonly AccountRow[],
  snapshots: readonly SnapshotRow[],
  links = accounts.map((a) => link(a.id)),
) {
  const progress = progressOf(row, links, accounts, snapshots, [], TODAY);
  return goalPath(row, progress, links, accounts, snapshots, [], TODAY);
}

describe('goalPath', () => {
  it('has no path for a goal with no accounts', () => {
    expect(pathOf(goal(), [], [])).toEqual({ kind: 'none' });
  });

  it('walks a saving from its start by month-ends counted back from today', () => {
    const accounts = [account('sav', 1_400_000)];
    const path = pathOf(goal(), accounts, monthly('sav', 1_000_000, 100_000));
    if (path.kind !== 'path') throw new Error(path.kind);
    expect(path.past.map((p) => p.on)).toEqual([
      '2026-05-10',
      '2026-05-26',
      '2026-06-26',
      '2026-07-26',
      '2026-08-26',
      TODAY,
    ]);
    expect(path.past[0]).toEqual({ on: '2026-05-10', minor: 1_000_000n, kind: 'monarch' });
    expect(path.past[5]).toEqual({ on: TODAY, minor: 1_400_000n, kind: 'read' });
    expect(path.lineMinor).toBe(2_000_000n);
    // The pace GOAL-01 states, the line it meets and when.
    expect(path.finish?.minor).toBe(2_000_000n);
    expect(path.finish?.on.slice(0, 7)).toBe('2027-03');
  });

  it('draws a payoff as what is owed, heading for nothing', () => {
    const row = goal({ kind: 'payoff', target_minor: null, name: 'Civic' });
    const accounts = [account('car', -600_000)];
    const path = pathOf(row, accounts, monthly('car', -1_000_000, 100_000));
    if (path.kind !== 'path') throw new Error(path.kind);
    expect(path.past[0]?.minor).toBe(1_000_000n);
    expect(path.past[path.past.length - 1]?.minor).toBe(600_000n);
    expect(path.lineMinor).toBe(0n);
    expect(path.finish?.minor).toBe(0n);
  });

  it('shows a loan in credit as owing nothing', () => {
    const row = goal({ kind: 'payoff', target_minor: null });
    const accounts = [account('car', 5_000)];
    const path = pathOf(row, accounts, monthly('car', -300_000, 100_000));
    if (path.kind !== 'path') throw new Error(path.kind);
    expect(path.past[4]?.minor).toBe(0n);
    expect(path.finish).toBeNull();
  });

  it('has no finish when it is not moving, and only today when it starts today', () => {
    const accounts = [account('sav', 1_000_000)];
    const flat = pathOf(goal(), accounts, monthly('sav', 1_000_000, 0));
    if (flat.kind !== 'path') throw new Error(flat.kind);
    expect(flat.finish).toBeNull();

    const fresh = pathOf(goal({ starts_on: TODAY }), accounts, [snap('sav', TODAY, 1_000_000)]);
    if (fresh.kind !== 'path') throw new Error(fresh.kind);
    expect(fresh.past).toEqual([{ on: TODAY, minor: 1_000_000n, kind: 'read' }]);
  });

  it('starts at the first day every account has a row, and skips a day with none', () => {
    const accounts = [account('sav', 1_400_000)];
    const row = goal({ starts_on: '2026-01-01' });
    const path = pathOf(row, accounts, monthly('sav', 1_000_000, 100_000));
    if (path.kind !== 'path') throw new Error(path.kind);
    expect(path.past[0]?.on).toBe('2026-05-01');

    // An account with no rows at all: no common day, and no balance for any day before today.
    const none = pathOf(row, [account('sav', 1_400_000)], []);
    if (none.kind !== 'path') throw new Error(none.kind);
    expect(none.past).toEqual([{ on: TODAY, minor: 1_400_000n, kind: 'read' }]);
  });
});
