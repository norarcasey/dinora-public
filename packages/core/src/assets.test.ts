import { describe, expect, it } from 'vitest';

import type { AssetRow, AssetValueRow } from './assets.ts';
import {
  assetRowSchema,
  assetSide,
  assetValueRowSchema,
  changeOver,
  combineTotals,
  compareAssets,
  formatChange,
  onSide,
  propertyRows,
  propertyTotals,
  standings,
  standOf,
  startTogether,
  VALUE_STALE_DAYS,
} from './assets.ts';
import type { AccountRow } from './balances.ts';
import type { SnapshotRow } from './history.ts';
import { daysBetween } from './terms.ts';

function asset(id: string, overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    name: id,
    kind: 'home',
    currency: 'USD',
    acquired_on: null,
    cost_minor: null,
    financed_by: null,
    address: null,
    postal_code: null,
    vin: null,
    odometer_miles: null,
    odometer_on: null,
    metal: null,
    metal_mg: null,
    fineness: null,
    coin: null,
    coin_quantity: null,
    ...overrides,
  };
}

let made = 0;

function value(
  assetId: string,
  valuedOn: string,
  amount: number,
  overrides: Partial<AssetValueRow> = {},
): AssetValueRow {
  made += 1;
  return {
    id: `v${String(made).padStart(4, '0')}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    asset_id: assetId,
    valued_on: valuedOn,
    amount_minor: amount,
    source: 'entered',
    provider: null,
    low_minor: null,
    high_minor: null,
    coin_quantity: null,
    created_at: '2026-09-25T09:00:00+00:00',
    ...overrides,
  };
}

function account(id: string, balance: number, overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    institution: 'PSCU',
    name: 'Auto Loan',
    currency: 'USD',
    balance_minor: balance,
    balance_at: '2026-09-25T09:00:00+00:00',
    holdings: 0,
    source: 'simplefin',
    ...overrides,
  };
}

const TODAY = '2026-09-25';

describe('the rows', () => {
  it('reads an asset and a value as PostgREST sends them', () => {
    expect(assetRowSchema.safeParse(asset('home')).success).toBe(true);
    expect(assetValueRowSchema.safeParse(value('home', TODAY, 1)).success).toBe(true);
  });

  it('refuses a cost with no day it was paid, as the table does', () => {
    expect(assetRowSchema.safeParse(asset('ring', { cost_minor: 800_000 })).success).toBe(false);
    expect(
      assetRowSchema.safeParse(asset('ring', { cost_minor: 800_000, acquired_on: '2022-05-01' }))
        .success,
    ).toBe(true);
  });

  it('refuses a kind or a source it does not know, and a negative value', () => {
    expect(assetRowSchema.safeParse({ ...asset('boat'), kind: 'boat' }).success).toBe(false);
    expect(
      assetValueRowSchema.safeParse({ ...value('a', TODAY, 1), source: 'zillow' }).success,
    ).toBe(false);
    expect(assetValueRowSchema.safeParse(value('a', TODAY, -1)).success).toBe(false);
  });

  it('orders assets by name', () => {
    expect(
      [asset('b', { name: 'Silver' }), asset('a', { name: 'Jewelry' })]
        .sort(compareAssets)
        .map((a) => a.name),
    ).toEqual(['Jewelry', 'Silver']);
  });
});

describe('standOf', () => {
  it('takes the newest value set by today, and leaves one set for later waiting', () => {
    const stood = standOf(
      asset('home'),
      [
        value('home', '2026-01-01', 100),
        value('home', '2026-06-01', 200),
        value('home', '2026-12-01', 300),
        value('other', '2026-09-01', 999),
      ],
      [],
      TODAY,
    );
    expect(stood.current?.amount_minor).toBe(200);
    expect(stood.ageDays).toBe(daysBetween('2026-06-01', TODAY));
    expect(stood.history.map((row) => row.amount_minor)).toEqual([300, 200, 100]);
  });

  it('takes the later of two values set the same day, and passes over one removed', () => {
    const stood = standOf(
      asset('home'),
      [
        value('home', TODAY, 100, { created_at: '2026-09-25T10:00:00+00:00' }),
        value('home', TODAY, 200, { created_at: '2026-09-25T11:00:00+00:00' }),
        value('home', TODAY, 300, {
          created_at: '2026-09-25T12:00:00+00:00',
          deleted_at: '2026-09-25T12:01:00+00:00',
        }),
      ],
      [],
      TODAY,
    );
    expect(stood.current?.amount_minor).toBe(200);
    expect(stood.history).toHaveLength(2);
  });

  it('has no value, age or change before one is set', () => {
    const stood = standOf(
      asset('home', { cost_minor: 1, acquired_on: '2020-01-01' }),
      [],
      [],
      TODAY,
    );
    expect(stood).toMatchObject({ current: null, ageDays: null, stale: false, change: null });
  });

  it(`turns stale after ${VALUE_STALE_DAYS} days, not on the day`, () => {
    const at = (days: number) =>
      new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
    const stale = (days: number) =>
      standOf(asset('car'), [value('car', at(days), 1)], [], TODAY).stale;
    expect(stale(VALUE_STALE_DAYS)).toBe(false);
    expect(stale(VALUE_STALE_DAYS + 1)).toBe(true);
  });

  it('says what it has gained since it was bought, and what it has lost', () => {
    const gold = standOf(
      asset('bracelet', { kind: 'valuables', cost_minor: 800_000, acquired_on: '2022-05-01' }),
      [value('bracelet', '2026-09-01', 1_400_000)],
      [],
      TODAY,
    );
    expect(gold.change).toEqual({ minor: 600_000, tenths: 750 });
    const car = standOf(
      asset('car', { kind: 'vehicle', cost_minor: 4_000_000, acquired_on: '2024-03-01' }),
      [value('car', '2026-09-01', 3_000_000)],
      [],
      TODAY,
    );
    expect(car.change).toEqual({ minor: -1_000_000, tenths: -250 });
  });

  it('reads the loan it was bought with, and what is owned of it', () => {
    const stood = standOf(
      asset('car', { financed_by: 'loan' }),
      [value('car', '2026-09-01', 3_000_000)],
      [account('loan', -1_800_000)],
      TODAY,
    );
    expect(stood.loan).toMatchObject({ owedMinor: 1_800_000, equityMinor: 1_200_000 });
    expect(stood.loan?.account.id).toBe('loan');
  });

  it('owes nothing on a loan in credit, and can be under water', () => {
    const paid = standOf(
      asset('car', { financed_by: 'loan' }),
      [value('car', TODAY, 100)],
      [account('loan', 5)],
      TODAY,
    );
    expect(paid.loan).toMatchObject({ owedMinor: 0, equityMinor: 100 });
    const under = standOf(
      asset('car', { financed_by: 'loan' }),
      [value('car', TODAY, 100)],
      [account('loan', -150)],
      TODAY,
    );
    expect(under.loan?.equityMinor).toBe(-50);
  });

  it('says no equity across currencies, or with no value yet', () => {
    const euros = standOf(
      asset('flat', { financed_by: 'loan', currency: 'EUR' }),
      [value('flat', TODAY, 100)],
      [account('loan', -50)],
      TODAY,
    );
    expect(euros.loan).toMatchObject({ owedMinor: 50, equityMinor: null });
    const unvalued = standOf(
      asset('flat', { financed_by: 'loan' }),
      [],
      [account('loan', -50)],
      TODAY,
    );
    expect(unvalued.loan?.equityMinor).toBeNull();
  });

  it('forgets a loan whose account is gone', () => {
    const stood = standOf(
      asset('car', { financed_by: 'loan' }),
      [],
      [account('loan', -1, { deleted_at: '2026-09-24T00:00:00+00:00' })],
      TODAY,
    );
    expect(stood.loan).toBeNull();
    expect(standOf(asset('car', { financed_by: 'gone' }), [], [], TODAY).loan).toBeNull();
  });
});

describe('standings and totals', () => {
  const assets = [
    asset('s', { name: 'Silver', kind: 'valuables' }),
    asset('h', { name: 'Apartment' }),
    asset('f', { name: 'Flat', currency: 'EUR' }),
    asset('x', { name: 'Sold', deleted_at: '2026-09-01T00:00:00+00:00' }),
    asset('n', { name: 'Not valued yet' }),
  ];
  const values = [
    value('s', '2025-01-15', 100),
    value('h', '2025-01-15', 1_000),
    value('f', '2025-01-15', 500),
    value('x', '2025-01-15', 7),
  ];

  it('stands every live asset, by name', () => {
    expect(standings(assets, values, [], TODAY).map((s) => s.asset.name)).toEqual([
      'Apartment',
      'Flat',
      'Not valued yet',
      'Silver',
    ]);
  });

  it('totals what is valued, one total per currency', () => {
    expect(propertyTotals(standings(assets, values, [], TODAY))).toEqual([
      { currency: 'EUR', minor: 500n, accounts: 1 },
      { currency: 'USD', minor: 1_100n, accounts: 2 },
    ]);
  });

  it('adds totals of the same currency together', () => {
    expect(
      combineTotals(
        [
          { currency: 'USD', minor: 1n, accounts: 1 },
          { currency: 'EUR', minor: 2n, accounts: 1 },
        ],
        [{ currency: 'USD', minor: 10n, accounts: 2 }],
      ),
    ).toEqual([
      { currency: 'EUR', minor: 2n, accounts: 1 },
      { currency: 'USD', minor: 11n, accounts: 3 },
    ]);
  });

  it('gives the chart every counted value of every live asset, oldest first, in its currency', () => {
    const rows = propertyRows(assets, [
      value('h', '2024-06-01', 900, { source: 'monarch' }),
      value('h', '2026-01-01', 2_000, { source: 'monarch' }),
      ...values,
      value('h', '2026-02-01', 3, { deleted_at: '2026-02-02T00:00:00+00:00' }),
    ]);
    expect(rows.map((r) => [r.asset_id, r.on_date, r.minor, r.currency, r.source])).toEqual([
      ['f', '2025-01-15', 500, 'EUR', 'entered'],
      ['h', '2024-06-01', 900, 'USD', 'monarch'],
      ['h', '2025-01-15', 1_000, 'USD', 'entered'],
      ['s', '2025-01-15', 100, 'USD', 'entered'],
    ]);
  });
});

describe('which side an asset counts toward (ACCT-21)', () => {
  it('is investments for crypto and property for everything else', () => {
    expect(assetSide('crypto')).toBe('investments');
    for (const kind of ['home', 'vehicle', 'valuables'] as const) {
      expect(assetSide(kind)).toBe('property');
    }
  });

  it('splits the standings and the chart’s rows by it', () => {
    const owned = [asset('h'), asset('c', { kind: 'crypto', coin: 'BTC', coin_quantity: '1' })];
    const vals = [value('h', '2025-01-15', 1_000), value('c', '2025-01-15', 50)];
    const stood = standings(owned, vals, [], TODAY);
    expect(onSide(stood, 'investments').map((s) => s.asset.id)).toEqual(['c']);
    expect(onSide(stood, 'property').map((s) => s.asset.id)).toEqual(['h']);
    expect(propertyRows(owned, vals).map((r) => [r.asset_id, r.side])).toEqual([
      ['c', 'investments'],
      ['h', 'property'],
    ]);
  });

  it('reads a holding’s quantity as the text it was stored as', () => {
    const row = assetRowSchema.safeParse(
      asset('c', { kind: 'crypto', coin: 'BTC', coin_quantity: '0.01230000' }),
    );
    expect(row.success && row.data.coin_quantity).toBe('0.01230000');
    expect(
      assetRowSchema.safeParse(asset('c', { kind: 'crypto', coin: 'BTC', coin_quantity: '1e-8' }))
        .success,
    ).toBe(false);
  });
});

describe('which value counts (ACCT-11)', () => {
  const home = asset('h');
  const estimate = (on: string, amount: number, overrides: Partial<AssetValueRow> = {}) =>
    value('h', on, amount, { source: 'estimate', provider: 'rentcast', ...overrides });

  it('counts the newest guess, Monarch’s or an estimate, until she sets a value', () => {
    const rows = [
      value('h', '2026-08-01', 500, { source: 'monarch' }),
      estimate('2026-09-20', 550),
    ];
    const stood = standOf(home, rows, [], '2026-09-25');
    expect(stood.current?.amount_minor).toBe(550);
    expect(stood.estimate?.id).toBe(stood.current?.id);
  });

  it('counts hers over any estimate, however much newer, and keeps the estimate beside it', () => {
    const rows = [
      estimate('2026-01-01', 400),
      value('h', '2026-03-01', 480),
      estimate('2026-09-20', 550),
    ];
    const stood = standOf(home, rows, [], '2026-09-25');
    expect(stood.current?.amount_minor).toBe(480);
    expect(stood.current?.source).toBe('entered');
    expect(stood.estimate?.amount_minor).toBe(550);
    expect(stood.history).toHaveLength(3);
  });

  it('draws the guesses before her first value and only hers from it on', () => {
    const rows = [
      estimate('2026-01-01', 400),
      value('h', '2026-03-01', 480),
      estimate('2026-03-01', 490),
      estimate('2026-09-20', 550),
    ];
    expect(propertyRows([home], rows).map((r) => [r.on_date, r.minor, r.source])).toEqual([
      ['2026-01-01', 400, 'estimate'],
      ['2026-03-01', 480, 'entered'],
    ]);
  });

  it('goes back to the guesses when her only value is removed', () => {
    const rows = [
      value('h', '2026-03-01', 480, { deleted_at: '2026-03-02T00:00:00+00:00' }),
      estimate('2026-09-20', 550),
    ];
    expect(standOf(home, rows, [], '2026-09-25').current?.amount_minor).toBe(550);
  });

  it('ignores a removed estimate and one dated after today', () => {
    const rows = [
      value('h', '2026-03-01', 480),
      estimate('2026-09-20', 550, { deleted_at: '2026-09-21T00:00:00+00:00' }),
      estimate('2026-09-30', 560),
    ];
    expect(standOf(home, rows, [], '2026-09-25').estimate).toBeNull();
  });

  it('reads an estimate’s provider and range, and refuses a provider it does not know', () => {
    const row = {
      ...estimate('2026-09-20', 550, { low_minor: 500, high_minor: 600 }),
    };
    expect(assetValueRowSchema.safeParse(row).success).toBe(true);
    expect(assetValueRowSchema.safeParse({ ...row, provider: 'zillow' }).success).toBe(false);
  });
});

describe('changes', () => {
  it('has no share of a cost of nothing', () => {
    expect(changeOver(100, 0)).toEqual({ minor: 100, tenths: null });
  });

  it('is always signed', () => {
    expect(formatChange(750)).toBe('+75%');
    expect(formatChange(234)).toBe('+23.4%');
    expect(formatChange(-250)).toBe('-25%');
    expect(formatChange(-5)).toBe('-0.5%');
    expect(formatChange(0)).toBe('0%');
  });
});

describe('an asset and its loan start together (ACCT-19, ACCT-20)', () => {
  const home = asset('h', { financed_by: 'mortgage' });
  const property = (rows: [string, number][]) =>
    propertyRows(
      [home],
      rows.map(([on, amount]) => value('h', on, amount, { source: 'monarch' })),
    );
  const snapshot = (on: string, balance: number, deleted: string | null = null): SnapshotRow => ({
    id: `s${on}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: deleted,
    account_id: 'mortgage',
    on_date: on,
    kind: 'read',
    currency: 'USD',
    balance_minor: balance,
    as_of: '2026-09-25T09:00:00+00:00',
  });
  const values = property([
    ['2025-01-15', 500],
    ['2025-06-01', 520],
    ['2026-10-01', 560],
  ]);
  const days = (out: ReturnType<typeof startTogether>) => ({
    property: out.property.map((r) => [r.on_date, r.minor]),
    snapshots: out.snapshots.map((r) => [r.on_date, r.balance_minor]),
  });

  it('carries the asset’s newest value to a loan that starts later, and leaves the older out', () => {
    expect(days(startTogether([home], values, [snapshot('2026-09-25', -400)]))).toEqual({
      property: [
        ['2026-09-25', 520],
        ['2026-10-01', 560],
      ],
      snapshots: [['2026-09-25', -400]],
    });
  });

  it('carries the loan’s newest balance to an asset that starts later', () => {
    const loan = [
      snapshot('2023-04-12', -581),
      snapshot('2025-01-13', -570),
      snapshot('2025-02-03', -569),
    ];
    expect(days(startTogether([home], values, loan))).toEqual({
      property: [
        ['2025-01-15', 500],
        ['2025-06-01', 520],
        ['2026-10-01', 560],
      ],
      snapshots: [
        ['2025-01-15', -570],
        ['2025-02-03', -569],
      ],
    });
  });

  it('keeps a figure set on the day they start over the one carried to it', () => {
    const out = startTogether(
      [home],
      property([
        ['2025-01-15', 500],
        ['2026-09-25', 540],
      ]),
      [snapshot('2026-09-25', -400)],
    );
    expect(days(out).property).toEqual([
      ['2026-09-25', 500],
      ['2026-09-25', 540],
    ]);
  });

  it('changes nothing without a loan, a loan’s balance or an asset’s value, and drops removed days', () => {
    const loan = [
      snapshot('2023-04-12', -581),
      snapshot('2023-01-01', -600, '2026-09-26T00:00:00+00:00'),
    ];
    const alone = {
      property: [
        ['2025-01-15', 500],
        ['2025-06-01', 520],
        ['2026-10-01', 560],
      ],
      snapshots: [['2023-04-12', -581]],
    };
    expect(days(startTogether([asset('h')], values, loan))).toEqual(alone);
    expect(days(startTogether([home], values, []))).toEqual({ ...alone, snapshots: [] });
    expect(days(startTogether([home], [], loan))).toEqual({
      property: [],
      snapshots: [['2023-04-12', -581]],
    });
  });
});
