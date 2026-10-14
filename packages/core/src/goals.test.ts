import { describe, expect, it } from 'vitest';

import type { AccountRow } from './balances.ts';
import type { GoalAccountRow, GoalRow } from './goals.ts';
import {
  accountsOf,
  balanceOn,
  compareGoalAccounts,
  compareGoals,
  defaultStart,
  firstCommonDay,
  formatShare,
  goalRowSchema,
  PACE_MIN_DAYS,
  progressOf,
} from './goals.ts';
import type { SnapshotRow } from './history.ts';
import type { RateRow } from './rates.ts';

const TODAY = '2026-09-25';

function account(id: string, minor: number, overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    institution: 'PSCU',
    name: id,
    currency: 'USD',
    balance_minor: minor,
    balance_at: '2026-09-25T09:00:00+00:00',
    holdings: 0,
    source: 'simplefin',
    ...overrides,
  };
}

function snap(
  accountId: string,
  onDate: string,
  minor: number,
  kind: SnapshotRow['kind'] = 'read',
  overrides: Partial<SnapshotRow> = {},
): SnapshotRow {
  return {
    id: `${accountId}-${onDate}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    account_id: accountId,
    on_date: onDate,
    kind,
    currency: 'USD',
    balance_minor: minor,
    as_of: `${onDate}T09:00:00+00:00`,
    ...overrides,
  };
}

function rate(rateDate: string, value: string): RateRow {
  return {
    id: rateDate,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    source: 'ecb',
    base: 'EUR',
    quote: 'USD',
    rate_date: rateDate,
    rate: value,
  };
}

function goal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: 'g1',
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    name: 'Emergency fund',
    kind: 'save',
    currency: 'USD',
    target_minor: 2_000_000,
    starts_on: '2026-01-01',
    target_on: null,
    created_at: '2026-09-25T09:00:00+00:00',
    ...overrides,
  };
}

function payoff(overrides: Partial<GoalRow> = {}): GoalRow {
  return goal({ id: 'g2', name: 'Civic', kind: 'payoff', target_minor: null, ...overrides });
}

function link(goalId: string, accountId: string, overrides: Partial<GoalAccountRow> = {}) {
  return {
    id: `${goalId}-${accountId}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    goal_id: goalId,
    account_id: accountId,
    ...overrides,
  };
}

describe('the rows', () => {
  it('insists a saving has a target and a payoff none, as the table does', () => {
    expect(goalRowSchema.safeParse(goal()).success).toBe(true);
    expect(goalRowSchema.safeParse(payoff()).success).toBe(true);
    expect(goalRowSchema.safeParse(goal({ target_minor: null })).success).toBe(false);
    expect(goalRowSchema.safeParse(payoff({ target_minor: 100 })).success).toBe(false);
  });

  it('lists goals in the order she made them', () => {
    const later = goal({ id: 'a', created_at: '2026-09-26T09:00:00+00:00' });
    const sooner = goal({ id: 'b', created_at: '2026-09-25T09:00:00+00:00' });
    expect([later, sooner].sort(compareGoals).map((g) => g.id)).toEqual(['b', 'a']);
    expect(compareGoals(goal({ id: 'a' }), goal({ id: 'b' }))).toBeLessThan(0);
    expect(compareGoalAccounts(link('a', 'x'), link('b', 'x'))).toBeLessThan(0);
    expect(compareGoalAccounts(link('a', 'x'), link('a', 'y'))).toBeLessThan(0);
  });
});

describe('accountsOf', () => {
  it('counts live links to live accounts only', () => {
    const accounts = [
      account('sav', 1),
      account('gone', 1, { deleted_at: TODAY }),
      account('chk', 1),
    ];
    const links = [
      link('g1', 'sav'),
      link('g1', 'gone'),
      link('g1', 'chk', { deleted_at: TODAY }),
      link('g2', 'chk'),
    ];
    expect(accountsOf('g1', links, accounts).map((a) => a.id)).toEqual(['sav']);
  });
});

describe('balanceOn', () => {
  const rows = [
    snap('a', '2026-06-01', 1_000, 'monarch'),
    snap('a', '2026-06-10', 2_000),
    snap('b', '2026-06-05', 500, 'rebuilt'),
    snap('b', '2026-06-07', 999, 'read', { deleted_at: TODAY }),
  ];

  it('carries each account forward from its newest live row, and keeps the least sure', () => {
    expect(balanceOn(['a', 'b'], rows, [], 'USD', '2026-06-08')).toEqual({
      kind: 'summed',
      minor: 1_500n,
      sureness: 'rebuilt',
    });
    expect(balanceOn(['a'], rows, [], 'USD', '2026-06-10')).toEqual({
      kind: 'summed',
      minor: 2_000n,
      sureness: 'read',
    });
  });

  it('says missing when an account has no row that early', () => {
    expect(balanceOn(['a', 'b'], rows, [], 'USD', '2026-06-02')).toEqual({ kind: 'missing' });
  });

  it('converts at the rate that day had', () => {
    const euro = [snap('e', '2026-06-01', 10_000, 'read', { currency: 'EUR' })];
    const rates = [rate('2026-06-01', '1.1'), rate('2026-09-01', '1.2')];
    expect(balanceOn(['e'], euro, rates, 'USD', '2026-06-05')).toMatchObject({ minor: 11_000n });
    expect(balanceOn(['e'], euro, [], 'USD', '2026-06-05')).toEqual({ kind: 'unrated' });
  });

  it('finds the first day every account has a row', () => {
    expect(firstCommonDay(['a', 'b'], rows)).toBe('2026-06-05');
    expect(firstCommonDay(['a', 'nothing'], rows)).toBeNull();
    expect(firstCommonDay([], rows)).toBeNull();
  });
});

describe('a saving', () => {
  // $12,000 on 27 Jun, 90 days before today, and $15,000 now, against $20,000.
  const accounts = [account('sav', 1_500_000)];
  const links = [link('g1', 'sav')];
  const rows = [snap('sav', '2026-06-01', 1_100_000), snap('sav', '2026-06-27', 1_200_000)];

  it('is the whole balance against the target, at the pace of the last 90 days', () => {
    const progress = progressOf(goal(), links, accounts, rows, [], TODAY);
    expect(progress).toMatchObject({
      kind: 'save',
      balanceMinor: 1_500_000n,
      targetMinor: 2_000_000n,
      tenths: 750,
      reached: false,
      gapMinor: 500_000n,
      deadline: null,
      pace: {
        kind: 'moving',
        from: '2026-06-27',
        movedMinor: 300_000n,
        // $3,000 in 90 days is 300,000 × 365 / 1,080 a month, rounded down.
        perMonthMinor: 101_388n,
        // $5,000 to go at $3,000 per 90 days is 150 days.
        finishOn: '2027-02-22',
      },
    });
  });

  it('says it is behind a date the pace misses, and what each month would have to add', () => {
    const progress = progressOf(
      goal({ target_on: '2027-01-01' }),
      links,
      accounts,
      rows,
      [],
      TODAY,
    );
    expect(progress).toMatchObject({
      // 98 days to 1 Jan: $5,000 × 365 / (12 × 98) a month.
      deadline: { on: '2027-01-01', daysLeft: 98, perMonthNeededMinor: 155_187n, onPace: false },
    });
  });

  it('says it is on pace for a date the pace makes', () => {
    const progress = progressOf(
      goal({ target_on: '2027-03-01' }),
      links,
      accounts,
      rows,
      [],
      TODAY,
    );
    expect(progress).toMatchObject({ deadline: { onPace: true } });
  });

  it('is reached once the balance meets the target, and past it the share runs over', () => {
    const progress = progressOf(goal(), links, [account('sav', 2_100_000)], rows, [], TODAY);
    expect(progress).toMatchObject({ reached: true, gapMinor: 0n, tenths: 1050 });
    const due = progressOf(
      goal({ target_on: '2026-12-01' }),
      links,
      [account('sav', 2_100_000)],
      rows,
      [],
      TODAY,
    );
    expect(due).toMatchObject({ deadline: { onPace: true, perMonthNeededMinor: null } });
    if (due.kind === 'save') expect(due.pace).toMatchObject({ kind: 'moving', finishOn: TODAY });
  });

  it('counts a negative balance as nothing saved', () => {
    const progress = progressOf(goal(), links, [account('sav', -5)], rows, [], TODAY);
    expect(progress).toMatchObject({ tenths: 0 });
  });

  it('is too early to pace for its first month', () => {
    const progress = progressOf(
      goal({ starts_on: '2026-09-10' }),
      links,
      accounts,
      rows,
      [],
      TODAY,
    );
    expect(progress).toMatchObject({ pace: { kind: 'too-early', days: 15 } });
    expect(15).toBeLessThan(PACE_MIN_DAYS);
  });

  it('paces from the first day every account has a row, when that is after her start', () => {
    const recent = [snap('sav', '2026-09-01', 1_000_000)];
    const progress = progressOf(goal(), links, accounts, recent, [], TODAY);
    expect(progress).toMatchObject({ pace: { kind: 'too-early', days: 24 } });
  });

  it('is stalled when the balance has not grown, and so behind any date', () => {
    const progress = progressOf(
      goal({ target_on: '2027-06-01' }),
      links,
      [account('sav', 1_100_000)],
      rows,
      [],
      TODAY,
    );
    expect(progress).toMatchObject({
      pace: { kind: 'stalled', movedMinor: -100_000n },
      deadline: { onPace: false },
    });
  });

  it('gives no finish date more than a century away', () => {
    const slow = [snap('sav', '2026-06-27', 1_499_999)];
    const progress = progressOf(goal(), links, accounts, slow, [], TODAY);
    expect(progress).toMatchObject({ pace: { kind: 'moving', finishOn: null } });
    const due = progressOf(goal({ target_on: '2027-01-01' }), links, accounts, slow, [], TODAY);
    expect(due).toMatchObject({ deadline: { onPace: false } });
  });

  it('says nothing of a date that has passed but what is left', () => {
    const progress = progressOf(
      goal({ starts_on: '2026-01-01', target_on: '2026-09-01' }),
      links,
      accounts,
      rows,
      [],
      TODAY,
    );
    expect(progress).toMatchObject({
      deadline: { daysLeft: -24, perMonthNeededMinor: null, onPace: false },
    });
  });

  it('needs an account to count', () => {
    expect(progressOf(goal(), [], accounts, rows, [], TODAY)).toEqual({ kind: 'no-accounts' });
  });

  it('is unsaid while an account has no rate into the goal’s currency', () => {
    const euro = [account('sav', 1_000, { currency: 'EUR' })];
    expect(progressOf(goal(), links, euro, rows, [], TODAY)).toEqual({ kind: 'unrated' });
  });

  it('cannot pace from a day that had no rate yet', () => {
    const euro = [account('sav', 1_000, { currency: 'EUR' })];
    const euroRows = [snap('sav', '2026-06-01', 900, 'read', { currency: 'EUR' })];
    const progress = progressOf(goal(), links, euro, euroRows, [rate('2026-09-24', '1.1')], TODAY);
    expect(progress).toMatchObject({ kind: 'save', pace: { kind: 'unknown' } });
  });
});

describe('a payoff', () => {
  // The Civic's loan: $30,000 owed on Monarch's first day, $18,000 on 27 Jun, $15,000 now.
  const accounts = [account('car', -1_500_000)];
  const links = [link('g2', 'car')];
  const rows = [
    snap('car', '2024-04-16', -3_000_000, 'monarch'),
    snap('car', '2026-06-27', -1_800_000),
  ];

  it('is measured from what was owed on the start, moved to the first day it has', () => {
    const progress = progressOf(
      payoff({ starts_on: '2024-01-01' }),
      links,
      accounts,
      rows,
      [],
      TODAY,
    );
    expect(progress).toMatchObject({
      kind: 'payoff',
      owedMinor: 1_500_000n,
      start: {
        kind: 'owed',
        on: '2024-04-16',
        moved: true,
        owedMinor: 3_000_000n,
        sureness: 'monarch',
      },
      paidMinor: 1_500_000n,
      tenths: 500,
      reached: false,
      gapMinor: 1_500_000n,
      // $3,000 paid in the last 90 days: $15,000 more takes 450.
      pace: { kind: 'moving', from: '2026-06-27', movedMinor: 300_000n, finishOn: '2027-12-19' },
    });
  });

  it('keeps her start when the loan has a row for it', () => {
    const progress = progressOf(
      payoff({ starts_on: '2026-06-27' }),
      links,
      accounts,
      rows,
      [],
      TODAY,
    );
    expect(progress).toMatchObject({
      start: { on: '2026-06-27', moved: false, owedMinor: 1_800_000n, sureness: 'read' },
      paidMinor: 300_000n,
      tenths: 166,
    });
  });

  it('is reached at zero owed', () => {
    const progress = progressOf(payoff(), links, [account('car', 0)], rows, [], TODAY);
    expect(progress).toMatchObject({ reached: true, owedMinor: 0n, tenths: 1000, gapMinor: 0n });
  });

  it('counts owing more than at the start as nothing paid, not a negative share', () => {
    const progress = progressOf(payoff(), links, [account('car', -3_100_000)], rows, [], TODAY);
    expect(progress).toMatchObject({ paidMinor: -100_000n, tenths: 0 });
  });

  it('has no share to measure when nothing was owed on the start', () => {
    const clear = [snap('car', '2026-01-01', 0)];
    const progress = progressOf(payoff(), links, accounts, clear, [], TODAY);
    expect(progress).toMatchObject({
      start: { kind: 'nothing-owed', on: '2026-01-01' },
      paidMinor: null,
      tenths: null,
    });
  });

  it('has no start before the loan has any history', () => {
    const progress = progressOf(payoff(), links, accounts, [], [], TODAY);
    expect(progress).toMatchObject({ start: { kind: 'unknown' }, paidMinor: null, tenths: null });
  });
});

describe('what the form offers', () => {
  const rows = [snap('a', '2024-04-16', -1), snap('b', '2025-01-01', -1)];

  it('starts at the oldest day every chosen account has', () => {
    expect(defaultStart(['a', 'b'], rows, TODAY)).toBe('2025-01-01');
    expect(defaultStart(['a'], rows, TODAY)).toBe('2024-04-16');
  });

  it('starts today with nothing chosen or no history', () => {
    expect(defaultStart([], rows, TODAY)).toBe(TODAY);
    expect(defaultStart(['c'], rows, TODAY)).toBe(TODAY);
  });

  it('writes a share as short as it is exact', () => {
    expect(formatShare(425)).toBe('42.5%');
    expect(formatShare(1000)).toBe('100%');
    expect(formatShare(0)).toBe('0%');
  });
});
