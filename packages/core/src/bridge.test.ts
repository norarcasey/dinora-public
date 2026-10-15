import { describe, expect, it } from 'vitest';

import type { PropertyRow } from './assets.ts';
import type { Bridge, BridgePart } from './bridge.ts';
import { endOfLastMonth, likeForLike, monthBridge, stepsOf } from './bridge.ts';
import type { Side } from './groups.ts';
import type { SnapshotRow } from './history.ts';
import { netWorthByDay } from './networth.ts';
import type { RateRow } from './rates.ts';

function snap(
  account: string,
  onDate: string,
  minor: number,
  overrides: Partial<SnapshotRow> = {},
): SnapshotRow {
  return {
    id: `${account}-${onDate}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    account_id: account,
    on_date: onDate,
    kind: 'read',
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

function value(
  asset: string,
  onDate: string,
  minor: number,
  side: PropertyRow['side'] = 'property',
): PropertyRow {
  return { asset_id: asset, side, on_date: onDate, currency: 'USD', minor, source: 'entered' };
}

const sides = (entries: Record<string, Side | null>) => new Map(Object.entries(entries));

function part(bridge: Bridge | null, name: BridgePart['part']): BridgePart | undefined {
  return bridge?.parts.find((p) => p.part === name);
}

/** The property the whole bridge rests on: the ends and the parts agree to the cent. */
function adds(bridge: Bridge | null): boolean {
  if (bridge === null) return false;
  return bridge.from.minor + bridge.parts.reduce((sum, p) => sum + p.minor, 0n) === bridge.to.minor;
}

describe('endOfLastMonth', () => {
  it('is the day before the month began, across a year and a leap February', () => {
    expect(endOfLastMonth('2026-09-26')).toBe('2026-08-31');
    expect(endOfLastMonth('2026-01-01')).toBe('2025-12-31');
    expect(endOfLastMonth('2028-03-15')).toBe('2028-02-29');
  });
});

describe('monthBridge', () => {
  it('has nothing to say with no history, or one day of it', () => {
    expect(monthBridge([], sides({ a: 'cash' }), [])).toBeNull();
    expect(monthBridge([snap('a', '2026-09-26', 100)], sides({ a: 'cash' }), [])).toBeNull();
  });

  it('walks from the end of last month to the last day, one part per side', () => {
    const bridge = monthBridge(
      [
        snap('checking', '2026-08-31', 500_000),
        snap('checking', '2026-09-26', 520_000),
        snap('brokerage', '2026-08-31', 1_000_000),
        snap('brokerage', '2026-09-26', 1_030_000),
        snap('card', '2026-08-31', -80_000),
        snap('card', '2026-09-26', -50_000),
      ],
      sides({ checking: 'cash', brokerage: 'investments', card: 'debt' }),
      [],
    );
    expect(bridge).toEqual({
      currency: 'USD',
      from: { on_date: '2026-08-31', minor: 1_420_000n, kind: 'read', conversions: [] },
      to: { on_date: '2026-09-26', minor: 1_500_000n, kind: 'read', conversions: [] },
      parts: [
        {
          part: 'cash',
          minor: 20_000n,
          members: [{ kind: 'account', id: 'checking', currency: 'USD', minor: 20_000n }],
        },
        {
          part: 'investments',
          minor: 30_000n,
          members: [{ kind: 'account', id: 'brokerage', currency: 'USD', minor: 30_000n }],
        },
        // Paid down is positive: it is what the net gained.
        {
          part: 'debt',
          minor: 30_000n,
          members: [{ kind: 'account', id: 'card', currency: 'USD', minor: 30_000n }],
        },
      ],
    });
  });

  it('agrees with the chart at both ends', () => {
    const rows = [
      snap('checking', '2026-08-20', 400_000),
      snap('checking', '2026-09-03', 450_000),
      snap('savings', '2026-08-25', 90_000, { currency: 'EUR' }),
      snap('savings', '2026-09-20', 95_000, { currency: 'EUR' }),
    ];
    const accounts = sides({ checking: 'cash', savings: 'cash' });
    const rates = [rate('2026-08-28', '1.1000'), rate('2026-09-25', '1.1700')];
    const bridge = monthBridge(rows, accounts, rates);
    const days = netWorthByDay(rows, accounts, rates).days;
    const figure = (day: string) => days.find((d) => d.on_date === day)?.minor;
    expect(bridge?.from.minor).toBe(figure('2026-08-31'));
    expect(bridge?.to.minor).toBe(figure('2026-09-20'));
  });

  it('carries a balance forward to each end, as the chart does', () => {
    const bridge = monthBridge(
      [
        snap('checking', '2026-08-12', 100_000),
        snap('checking', '2026-09-10', 130_000),
        snap('card', '2026-09-26', -5_000),
        snap('card', '2026-08-01', -9_000),
      ],
      sides({ checking: 'cash', card: 'debt' }),
      [],
    );
    expect(bridge?.from).toEqual({
      on_date: '2026-08-31',
      minor: 91_000n,
      kind: 'read',
      conversions: [],
    });
    expect(part(bridge, 'cash')?.minor).toBe(30_000n);
    expect(part(bridge, 'debt')?.minor).toBe(4_000n);
  });

  it('counts an account first read this month as new, not as a month of gains', () => {
    const bridge = monthBridge(
      [
        snap('checking', '2026-08-31', 100_000),
        snap('checking', '2026-09-26', 100_000),
        snap('mortgage', '2026-09-15', -30_000_000),
        snap('mortgage', '2026-09-26', -29_900_000),
      ],
      sides({ checking: 'cash', mortgage: 'debt' }),
      [],
    );
    expect(part(bridge, 'debt')).toBeUndefined();
    expect(part(bridge, 'new')).toEqual({
      part: 'new',
      minor: -29_900_000n,
      members: [{ kind: 'account', id: 'mortgage', currency: 'USD', minor: -29_900_000n }],
    });
    expect(part(bridge, 'cash')?.minor).toBe(0n);
    expect(adds(bridge)).toBe(true);
  });

  it('counts an asset valued for the first time this month as new, and a revalued one as property', () => {
    const bridge = monthBridge(
      [snap('checking', '2026-08-31', 100_000), snap('checking', '2026-09-26', 100_000)],
      sides({ checking: 'cash' }),
      [],
      [
        value('flat', '2026-06-01', 40_000_000),
        value('flat', '2026-09-20', 41_000_000),
        value('bracelet', '2026-09-12', 1_200_000),
      ],
    );
    expect(part(bridge, 'property')).toEqual({
      part: 'property',
      minor: 1_000_000n,
      members: [{ kind: 'asset', id: 'flat', currency: 'USD', minor: 1_000_000n }],
    });
    expect(part(bridge, 'new')?.members).toEqual([
      { kind: 'asset', id: 'bracelet', currency: 'USD', minor: 1_200_000n },
    ]);
    expect(adds(bridge)).toBe(true);
  });

  it('counts a crypto holding’s change toward investments', () => {
    const bridge = monthBridge(
      [snap('checking', '2026-08-31', 100_000), snap('checking', '2026-09-26', 100_000)],
      sides({ checking: 'cash' }),
      [],
      [
        value('btc', '2026-08-30', 100_000, 'investments'),
        value('btc', '2026-09-25', 90_000, 'investments'),
      ],
    );
    expect(part(bridge, 'investments')?.minor).toBe(-10_000n);
    expect(part(bridge, 'property')).toBeUndefined();
    expect(adds(bridge)).toBe(true);
  });

  it('keeps an account in no group apart from the sides', () => {
    const bridge = monthBridge(
      [snap('mystery', '2026-08-31', 10_000), snap('mystery', '2026-09-26', 12_500)],
      sides({ mystery: null }),
      [],
    );
    expect(bridge?.parts).toEqual([
      {
        part: 'unsided',
        minor: 2_500n,
        members: [{ kind: 'account', id: 'mystery', currency: 'USD', minor: 2_500n }],
      },
    ]);
  });

  it('says what the euro did to what was already held, apart from what was saved', () => {
    const bridge = monthBridge(
      [
        snap('castellana', '2026-08-31', 1_000_000, { currency: 'EUR' }),
        snap('castellana', '2026-09-25', 1_000_000, { currency: 'EUR' }),
      ],
      sides({ castellana: 'cash' }),
      [rate('2026-08-31', '1.1000'), rate('2026-09-25', '1.1700')],
    );
    // €10,000 untouched, at 1.10 then 1.17: $700 of change, none of it saved.
    expect(bridge?.from.minor).toBe(1_100_000n);
    expect(bridge?.to.minor).toBe(1_170_000n);
    expect(part(bridge, 'cash')?.minor).toBe(0n);
    expect(part(bridge, 'rate')).toEqual({ part: 'rate', minor: 70_000n, members: [] });
    expect(bridge?.from.conversions.map((c) => c.rate.rate_date)).toEqual(['2026-08-31']);
    expect(bridge?.to.conversions.map((c) => c.rate.rate)).toEqual(['1.1700']);
  });

  it('sums exactly when the rounding of many conversions would not', () => {
    const bridge = monthBridge(
      [
        snap('a', '2026-08-31', 333, { currency: 'EUR' }),
        snap('a', '2026-09-25', 1_001, { currency: 'EUR' }),
        snap('b', '2026-08-31', 777, { currency: 'EUR' }),
        snap('b', '2026-09-25', 5, { currency: 'EUR' }),
        snap('c', '2026-08-31', -101, { currency: 'EUR' }),
        snap('c', '2026-09-25', -999, { currency: 'EUR' }),
        snap('d', '2026-09-01', 1_234, { currency: 'EUR' }),
        snap('d', '2026-09-25', 1_235, { currency: 'EUR' }),
      ],
      sides({ a: 'cash', b: 'investments', c: 'debt', d: 'cash' }),
      [rate('2026-08-29', '1.13579'), rate('2026-09-25', '1.16667')],
    );
    expect(adds(bridge)).toBe(true);
    expect(bridge?.parts.map((p) => p.part)).toEqual([
      'cash',
      'investments',
      'debt',
      'rate',
      'new',
    ]);
  });

  it('puts the part that moved most first', () => {
    const bridge = monthBridge(
      [
        snap('small', '2026-08-31', 100_000),
        snap('small', '2026-09-26', 101_000),
        snap('big', '2026-08-31', 100_000),
        snap('big', '2026-09-26', 50_000),
        snap('euro', '2026-08-31', 100_000, { currency: 'EUR' }),
        snap('euro', '2026-09-26', 120_000, { currency: 'EUR' }),
      ],
      sides({ small: 'cash', big: 'cash', euro: 'cash' }),
      [rate('2026-08-31', '1.1'), rate('2026-09-26', '1.2')],
    );
    expect(part(bridge, 'cash')?.members.map((m) => m.id)).toEqual(['big', 'euro', 'small']);
  });

  it('reads in euros at the ECB’s rate read backwards, and still sorts dollars by size', () => {
    const bridge = monthBridge(
      [
        snap('card', '2026-08-31', -100_000),
        snap('card', '2026-09-26', -40_000),
        snap('castellana', '2026-08-31', 100_000, { currency: 'EUR' }),
        snap('castellana', '2026-09-26', 110_000, { currency: 'EUR' }),
      ],
      sides({ card: 'debt', castellana: 'cash' }),
      [rate('2026-08-31', '1.25'), rate('2026-09-26', '1.25')],
      [],
      'EUR',
    );
    // $600 paid off is €480; €100 saved. At an unmoved rate nothing is left for the rate part.
    expect(bridge?.currency).toBe('EUR');
    expect(part(bridge, 'debt')?.minor).toBe(48_000n);
    expect(part(bridge, 'cash')?.minor).toBe(10_000n);
    expect(part(bridge, 'rate')?.minor).toBe(0n);
    expect(adds(bridge)).toBe(true);
    expect(bridge?.to.conversions.map((c) => [c.currency, c.rate.base, c.rate.quote])).toEqual([
      ['USD', 'EUR', 'USD'],
    ]);

    const mixed = monthBridge(
      [
        snap('small', '2026-08-31', 0, { currency: 'EUR' }),
        snap('small', '2026-09-26', 10_000, { currency: 'EUR' }),
        snap('big', '2026-08-31', 0),
        snap('big', '2026-09-26', 50_000),
      ],
      sides({ small: 'cash', big: 'cash' }),
      [rate('2026-08-31', '1.25'), rate('2026-09-26', '1.25')],
      [],
      'EUR',
    );
    // $500 is €400, more than €100: read only one way round, the dollars sorted as nothing.
    expect(part(mixed, 'cash')?.members.map((m) => m.id)).toEqual(['big', 'small']);
  });

  it('is left unsaid when a currency has no rate', () => {
    expect(
      monthBridge(
        [
          snap('castellana', '2026-08-31', 100, { currency: 'EUR' }),
          snap('castellana', '2026-09-25', 100, { currency: 'EUR' }),
        ],
        sides({ castellana: 'cash' }),
        [],
      ),
    ).toBeNull();
  });

  it('starts at the first day when the history is younger than the month', () => {
    const bridge = monthBridge(
      [snap('a', '2026-09-10', 100), snap('a', '2026-09-26', 400)],
      sides({ a: 'cash' }),
      [],
    );
    expect(bridge?.from.on_date).toBe('2026-09-10');
    expect(part(bridge, 'cash')?.minor).toBe(300n);
  });

  it('says how sure each end is, as the chart would', () => {
    const bridge = monthBridge(
      [
        snap('a', '2026-08-31', 100, { kind: 'rebuilt' }),
        snap('a', '2026-09-26', 200),
        snap('b', '2026-08-31', 100, { kind: 'monarch' }),
        snap('b', '2026-09-26', 200),
      ],
      sides({ a: 'cash', b: 'cash' }),
      [],
    );
    expect(bridge?.from.kind).toBe('rebuilt');
    expect(bridge?.to.kind).toBe('read');
  });

  it('leaves out what is gone: a deleted row, or an account no longer live', () => {
    const bridge = monthBridge(
      [
        snap('a', '2026-08-31', 100),
        snap('a', '2026-09-26', 200),
        snap('a', '2026-09-27', 9_999, { deleted_at: '2026-09-27T10:00:00+00:00' }),
        snap('closed', '2026-08-31', 5_000),
        snap('closed', '2026-09-26', 0),
      ],
      sides({ a: 'cash' }),
      [],
    );
    expect(bridge?.to).toEqual({
      on_date: '2026-09-26',
      minor: 200n,
      kind: 'read',
      conversions: [],
    });
    expect(bridge?.parts).toHaveLength(1);
  });
});

describe('stepsOf', () => {
  it('walks each part on from where the last one left off', () => {
    const bridge = monthBridge(
      [
        snap('checking', '2026-08-31', 500),
        snap('checking', '2026-09-26', 800),
        snap('card', '2026-08-31', -100),
        snap('card', '2026-09-26', -600),
      ],
      sides({ checking: 'cash', card: 'debt' }),
      [],
    );
    expect(bridge === null ? [] : stepsOf(bridge).map((s) => [s.before, s.after])).toEqual([
      [0n, 300n],
      [300n, -200n],
    ]);
  });
});

describe('the month without what was newly counted', () => {
  // As production stood on 26 Sep: the Harbor mortgage linked through Plaid that month.
  const bridge = monthBridge(
    [
      snap('checking', '2026-08-31', 500_000),
      snap('checking', '2026-09-26', 840_000),
      snap('harbor', '2026-09-12', -41_250_000),
      snap('harbor', '2026-09-26', -41_180_000),
    ],
    sides({ checking: 'cash', harbor: 'debt' }),
    [],
  );

  it('is the month’s figure, not the difference of the ends', () => {
    expect(bridge === null ? null : likeForLike(bridge)).toBe(340_000n);
    expect(bridge === null ? null : bridge.to.minor - bridge.from.minor).toBe(-40_840_000n);
  });

  it('is not a step of the walk, so it cannot flatten the bars that are', () => {
    expect(bridge === null ? [] : stepsOf(bridge).map((s) => s.part.part)).toEqual(['cash']);
  });
});
