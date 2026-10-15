import { describe, expect, it } from 'vitest';

import type { PropertyRow } from './assets.ts';
import type { SnapshotRow } from './history.ts';
import {
  axisTicks,
  columnsOf,
  dateTicks,
  describeDay,
  describePeriod,
  describeShortDay,
  endPad,
  inRange,
  lessSure,
  netWorthByDay,
  rangeStart,
} from './networth.ts';
import type { RateRow } from './rates.ts';

function snap(
  account: string,
  onDate: string,
  minor: number,
  kind: SnapshotRow['kind'] = 'read',
  overrides: Partial<SnapshotRow> = {},
): SnapshotRow {
  return {
    id: `${account}-${onDate}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    account_id: account,
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

/** Live accounts in no side: the net alone. */
function nthDay(from: string, n: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const ids = (...list: string[]) => new Map(list.map((id) => [id, null]));

describe('netWorthByDay', () => {
  it('has nothing to draw before the first night', () => {
    expect(netWorthByDay([], ids('a'), [])).toEqual({
      currency: 'USD',
      days: [],
      accounts: 0,
      sideAccounts: { cash: 0, investments: 0, property: 0, debt: 0 },
      firstRead: null,
      readDays: 0,
      monarchDays: 0,
      statementDays: 0,
      rebuiltDays: 0,
    });
  });

  it('sums the accounts by day with no flip, a card owed negative', () => {
    const history = netWorthByDay(
      [
        snap('savings', '2026-09-23', 70_000, 'rebuilt'),
        snap('card', '2026-09-23', -11_000, 'rebuilt'),
        snap('savings', '2026-09-24', 70_000),
        snap('card', '2026-09-24', -10_000),
      ],
      ids('savings', 'card'),
      [],
    );
    expect(
      history.days.map(({ on_date, minor, kind, counted }) => ({ on_date, minor, kind, counted })),
    ).toEqual([
      { on_date: '2026-09-23', minor: 59_000n, kind: 'rebuilt', counted: 2 },
      { on_date: '2026-09-24', minor: 60_000n, kind: 'read', counted: 2 },
    ]);
    expect(history.firstRead).toBe('2026-09-24');
    expect([history.readDays, history.rebuiltDays]).toEqual([1, 1]);
  });

  it('carries a balance forward through a night the bank did not refresh', () => {
    const history = netWorthByDay(
      [snap('a', '2026-09-24', 100), snap('a', '2026-09-27', 300)],
      ids('a'),
      [],
    );
    expect(history.days.map((day) => [day.on_date, day.minor, day.kind])).toEqual([
      ['2026-09-24', 100n, 'read'],
      ['2026-09-25', 100n, 'read'],
      ['2026-09-26', 100n, 'read'],
      ['2026-09-27', 300n, 'read'],
    ]);
  });

  it('counts an account only from its first row, and says how many days leave it out', () => {
    // A brokerage has no rebuilt days (ACCT-03): it joins the line on the first night.
    const history = netWorthByDay(
      [
        snap('card', '2026-09-23', -500, 'rebuilt'),
        snap('card', '2026-09-24', -600),
        snap('brokerage', '2026-09-24', 900_000),
      ],
      ids('card', 'brokerage'),
      [],
    );
    expect(history.days.map((day) => [day.minor, day.counted])).toEqual([
      [-500n, 1],
      [899_400n, 2],
    ]);
    expect(history.accounts).toBe(2);
  });

  it('marks a day rebuilt when any figure in it is', () => {
    const history = netWorthByDay(
      [snap('a', '2026-09-24', 1), snap('b', '2026-09-24', 1, 'rebuilt')],
      ids('a', 'b'),
      [],
    );
    expect(history.days[0]?.kind).toBe('rebuilt');
  });

  it("marks a day Monarch's when a figure is and none is rebuilt", () => {
    const history = netWorthByDay(
      [
        snap('a', '2026-09-22', 1, 'monarch'),
        snap('b', '2026-09-22', 1),
        snap('a', '2026-09-23', 1, 'rebuilt'),
        snap('a', '2026-09-24', 1),
      ],
      ids('a', 'b'),
      [],
    );
    expect(history.days.map((day) => day.kind)).toEqual(['monarch', 'rebuilt', 'read']);
    expect([history.readDays, history.monarchDays, history.rebuiltDays]).toEqual([1, 1, 1]);
  });

  it('leaves out rows of accounts that are gone, and removed rows', () => {
    const history = netWorthByDay(
      [
        snap('a', '2026-09-24', 100),
        snap('gone', '2026-09-20', 5_000),
        snap('a', '2026-09-25', 999, 'read', { deleted_at: '2026-09-25T10:00:00+00:00' }),
      ],
      ids('a'),
      [],
    );
    expect(history.days.map((day) => [day.on_date, day.minor, day.counted])).toEqual([
      ['2026-09-24', 100n, 1],
    ]);
  });

  it('converts each day at the newest rate on or before it', () => {
    const history = netWorthByDay(
      [
        snap('eur', '2026-09-18', 100_000, 'read', { currency: 'EUR' }),
        snap('eur', '2026-09-21', 100_000, 'read', { currency: 'EUR' }),
        snap('usd', '2026-09-18', 1_000),
      ],
      ids('eur', 'usd'),
      [rate('2026-09-18', '1.146'), rate('2026-09-21', '1.1500')],
    );
    // Friday's rate carries the weekend; Monday's is Monday's.
    expect(history.days.map((day) => [day.on_date, day.minor])).toEqual([
      ['2026-09-18', 115_600n],
      ['2026-09-19', 115_600n],
      ['2026-09-20', 115_600n],
      ['2026-09-21', 116_000n],
    ]);
  });

  it('leaves a day unsaid when a currency in it has no rate yet', () => {
    const history = netWorthByDay(
      [
        snap('eur', '2026-09-17', 100_000, 'read', { currency: 'EUR' }),
        snap('eur', '2026-09-18', 100_000, 'read', { currency: 'EUR' }),
      ],
      ids('eur'),
      [rate('2026-09-18', '1.146')],
    );
    expect(history.days.map((day) => day.minor)).toEqual([null, 114_600n]);
  });
});

describe('netWorthByDay, by side', () => {
  const sides = new Map([
    ['checking', 'cash'],
    ['card', 'debt'],
    ['loan', 'debt'],
    ['brokerage', 'investments'],
    ['unsure', null],
  ] as const);

  it('splits each day into cash, investments and debt, signed as the accounts are', () => {
    const history = netWorthByDay(
      [
        snap('checking', '2026-09-24', 70_000),
        snap('card', '2026-09-24', -10_000),
        snap('loan', '2026-09-24', -500_000),
        snap('brokerage', '2026-09-24', 900_000),
        snap('unsure', '2026-09-24', 3_000),
      ],
      sides,
      [],
    );
    const [day] = history.days;
    expect(day?.minor).toBe(463_000n);
    expect(day?.sides).toEqual({
      cash: { minor: 70_000n, kind: 'read', counted: 1 },
      investments: { minor: 900_000n, kind: 'read', counted: 1 },
      property: { minor: 0n, kind: 'read', counted: 0 },
      debt: { minor: -510_000n, kind: 'read', counted: 2 },
    });
    // The account in no side is in the net and in none of the three.
    expect(history.sideAccounts).toEqual({ cash: 1, investments: 1, property: 0, debt: 2 });
  });

  it("keeps each side's own kind and count, so a rebuilt card does not mark cash rebuilt", () => {
    const history = netWorthByDay(
      [
        snap('checking', '2026-09-23', 100),
        snap('card', '2026-09-23', -50, 'rebuilt'),
        snap('brokerage', '2026-09-24', 900),
      ],
      sides,
      [],
    );
    expect(history.days.map((day) => day.sides.cash.kind)).toEqual(['read', 'read']);
    expect(history.days.map((day) => day.sides.debt.kind)).toEqual(['rebuilt', 'rebuilt']);
    // An investment joins on its first row (ACCT-03): the day before counts none.
    expect(
      history.days.map((day) => [day.sides.investments.minor, day.sides.investments.counted]),
    ).toEqual([
      [0n, 0],
      [900n, 1],
    ]);
  });

  it('leaves a side unsaid when a currency in it has no rate, and the others said', () => {
    const history = netWorthByDay(
      [
        snap('checking', '2026-09-24', 100_000, 'read', { currency: 'EUR' }),
        snap('card', '2026-09-24', -50),
      ],
      sides,
      [],
    );
    expect(history.days[0]?.sides.cash.minor).toBeNull();
    expect(history.days[0]?.sides.debt.minor).toBe(-50n);
  });
});

describe('columnsOf', () => {
  const run = (from: string, count: number) =>
    netWorthByDay([snap('a', from, 1), snap('a', nthDay(from, count - 1), 2)], ids('a'), []).days;

  it('keeps a day each while they fit', () => {
    const { period, columns } = columnsOf(run('2026-09-20', 5), 10);
    expect(period).toBe('day');
    expect(columns.map((column) => column.from)).toEqual([
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
    ]);
  });

  it("goes to weeks from Monday, each showing its week's last day", () => {
    // Sun 13 Sep to Thu 24 Sep: part of one week, all of the next, most of a third.
    const { period, columns } = columnsOf(run('2026-09-13', 12), 5);
    expect(period).toBe('week');
    expect(columns.map((column) => [column.from, column.day.on_date])).toEqual([
      ['2026-09-07', '2026-09-13'],
      ['2026-09-14', '2026-09-20'],
      ['2026-09-21', '2026-09-24'],
    ]);
    expect(columns[2]?.day.minor).toBe(2n);
  });

  it('goes to months for a long history, and stays monthly past the limit', () => {
    const { period, columns } = columnsOf(run('2025-01-15', 618), 12);
    expect(period).toBe('month');
    expect(columns).toHaveLength(21);
    expect(columns[0]?.day.on_date).toBe('2025-01-31');
    expect(columns[20]?.from).toBe('2026-09-01');
  });

  it('has nothing to draw with no days', () => {
    expect(columnsOf([], 10).columns).toEqual([]);
  });
});

describe('describePeriod', () => {
  it('names a day, a week by its Monday, or a month', () => {
    expect(describePeriod('day', '2026-09-24', 'en-GB')).toBe('Thu, 24 Sept 2026');
    expect(describePeriod('week', '2026-09-21', 'en-GB')).toBe('Week of 21 Sept 2026');
    expect(describePeriod('month', '2026-09-01', 'en-GB')).toBe('Sept 2026');
  });
});

describe('endPad', () => {
  it('leaves room after the last day in step with the range', () => {
    expect(endPad(0)).toBe(0);
    expect(endPad(1)).toBe(0);
    expect(endPad(2)).toBe(1);
    expect(endPad(32)).toBe(1);
    expect(endPad(366)).toBe(15);
    expect(endPad(731)).toBe(29);
  });
});

describe('lessSure', () => {
  it('is rebuilt over Monarch over read, whichever way round', () => {
    expect(lessSure('read', 'monarch')).toBe('monarch');
    expect(lessSure('monarch', 'read')).toBe('monarch');
    expect(lessSure('monarch', 'rebuilt')).toBe('rebuilt');
    expect(lessSure('read', 'read')).toBe('read');
  });
});

describe('axisTicks', () => {
  it('spans the values in round dollars', () => {
    // $1,234.56 to $5,678.90 is a span of 4,445 whole dollars: a quarter of it rounds up to 2,000.
    expect(axisTicks([123_456n, 567_890n])).toEqual([0, 2_000, 4_000, 6_000]);
    expect(axisTicks([123_456n, 234_567n])).toEqual([1_000, 1_500, 2_000, 2_500]);
  });

  it('crosses zero for a net that goes negative', () => {
    expect(axisTicks([-150_050n, 250_000n])).toEqual([-2_000, 0, 2_000, 4_000]);
  });

  it('rounds outward only past a whole dollar', () => {
    expect(axisTicks([-100n, 300n])).toEqual([-1, 0, 1, 2, 3]);
  });

  it('gives a flat line a range of its own', () => {
    expect(axisTicks([500n])).toEqual([5, 6]);
    expect(axisTicks([])).toEqual([0, 1]);
  });

  it('reads a currency with no cents in whole units', () => {
    expect(axisTicks([0n, 400n], 'JPY')).toEqual([0, 100, 200, 300, 400]);
  });
});

describe('describeDay', () => {
  it('names the UTC day, whatever the reader’s zone', () => {
    expect(describeDay('2026-09-24', 'en-GB')).toBe('Thu, 24 Sept 2026');
    expect(describeShortDay('2026-09-24', 'en-GB')).toBe('24 Sept');
  });
});

describe('netWorthByDay, with property', () => {
  const sides = new Map([
    ['checking', 'cash'],
    ['mortgage', 'debt'],
  ] as const);

  function valued(
    asset: string,
    onDate: string,
    minor: number,
    source: PropertyRow['source'] = 'entered',
    currency = 'USD',
    side: PropertyRow['side'] = 'property',
  ): PropertyRow {
    return { asset_id: asset, side, on_date: onDate, currency, minor, source };
  }

  it('adds each asset to the net and to property, from the newest value on or before the day', () => {
    const history = netWorthByDay(
      [
        snap('checking', '2026-09-22', 1_000),
        snap('mortgage', '2026-09-22', -300_000),
        snap('checking', '2026-09-24', 2_000),
      ],
      sides,
      [],
      [
        // Bought long before the chart starts: its value is simply what it was on day one.
        valued('home', '2022-03-01', 400_000),
        valued('home', '2026-09-23', 450_000),
        valued('ring', '2026-09-24', 5_000),
      ],
    );
    expect(history.days.map((day) => day.on_date)).toEqual([
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
    ]);
    expect(history.days.map((day) => day.minor)).toEqual([101_000n, 151_000n, 157_000n]);
    expect(
      history.days.map((day) => [day.sides.property.minor, day.sides.property.counted]),
    ).toEqual([
      [400_000n, 1],
      [450_000n, 1],
      [455_000n, 2],
    ]);
    // An asset is not an account: the day still counts two of two.
    expect(history.days.map((day) => day.counted)).toEqual([2, 2, 2]);
    expect(history.accounts).toBe(2);
    expect(history.sideAccounts.property).toBe(2);
  });

  it('counts a crypto holding toward investments, not property', () => {
    const history = netWorthByDay(
      [snap('checking', '2026-09-24', 1_000)],
      sides,
      [],
      [
        valued('home', '2026-09-01', 400_000),
        valued('btc', '2026-09-23', 1_034, 'estimate', 'USD', 'investments'),
      ],
    );
    const [day] = history.days;
    expect(day?.minor).toBe(402_034n);
    expect(day?.sides.investments).toEqual({ minor: 1_034n, kind: 'read', counted: 1 });
    expect(day?.sides.property.minor).toBe(400_000n);
    expect(history.sideAccounts).toMatchObject({ property: 1, investments: 1 });
  });

  it("draws a day with her value as read, and one with a value of Monarch's as Monarch's", () => {
    const history = netWorthByDay(
      [snap('checking', '2026-09-23', 1_000), snap('checking', '2026-09-24', 1_000)],
      sides,
      [],
      [valued('car', '2026-09-01', 20_000, 'monarch'), valued('car', '2026-09-24', 19_000)],
    );
    expect(history.days.map((day) => day.kind)).toEqual(['monarch', 'read']);
    expect(history.days.map((day) => day.sides.property.kind)).toEqual(['monarch', 'read']);
    // The first night is the bank's alone: a value she set is not a reading.
    expect(history.firstRead).toBe('2026-09-23');
    expect(history.readDays).toBe(1);
  });

  it('draws nothing from property alone, before any account has a row', () => {
    const history = netWorthByDay([], sides, [], [valued('home', '2026-09-01', 1)]);
    expect(history.days).toEqual([]);
  });

  it('converts an asset in euros at the rate of each day', () => {
    const history = netWorthByDay(
      [snap('checking', '2026-09-24', 0)],
      sides,
      [rate('2026-09-24', '1.1')],
      [valued('flat', '2026-09-01', 100_000, 'entered', 'EUR')],
    );
    expect(history.days[0]?.sides.property.minor).toBe(110_000n);
  });
});

describe('rangeStart', () => {
  it('counts back from the last day, held to the end of a shorter month', () => {
    expect(rangeStart('1M', '2026-09-26')).toBe('2026-08-26');
    expect(rangeStart('1M', '2026-03-31')).toBe('2026-02-28');
    expect(rangeStart('3M', '2026-01-15')).toBe('2025-10-15');
    expect(rangeStart('YTD', '2026-09-26')).toBe('2026-01-01');
    expect(rangeStart('1Y', '2024-02-29')).toBe('2023-02-28');
    expect(rangeStart('All', '2026-09-26')).toBeNull();
  });
});

describe('inRange', () => {
  const history = netWorthByDay(
    [
      snap('a', '2025-06-01', 1, 'monarch'),
      snap('a', '2026-08-01', 2, 'rebuilt'),
      snap('a', '2026-09-20', 3, 'read'),
    ],
    ids('a'),
    [],
  );

  it('keeps the days from the range’s first, and counts them again', () => {
    const month = inRange(history, '1M');
    expect(month.days[0]?.on_date).toBe('2026-08-20');
    expect(month.days).toHaveLength(32);
    expect(month.monarchDays).toBe(0);
    expect(month.rebuiltDays).toBe(31);
    expect(month.readDays).toBe(1);
    expect(month.accounts).toBe(history.accounts);
    expect(history.monarchDays).toBeGreaterThan(0);
  });

  it('is the whole history for All, or for a range longer than it', () => {
    expect(inRange(history, 'All')).toBe(history);
    expect(inRange(history, '1Y').days).toHaveLength(366);
    const empty = netWorthByDay([], ids('a'), []);
    expect(inRange(empty, '1M')).toBe(empty);
  });
});

describe('dateTicks', () => {
  const days = (from: string, count: number) =>
    Array.from({ length: count }, (_, n) => nthDay(from, n));
  const labels = (ticks: readonly { label: string }[]) => ticks.map((tick) => tick.label);

  it('marks two years in months, with the year at January and the ends', () => {
    expect(labels(dateTicks(days('2024-09-26', 731), 14, false, 'en-GB'))).toEqual([
      '26 Sept 2024',
      'Jan 2025',
      'Mar',
      'May',
      'Jul',
      'Sept',
      'Nov',
      'Jan 2026',
      'Mar',
      'May',
      'Jul',
      '26 Sept 2026',
    ]);
  });

  it('marks fewer months as the width narrows, never crowding an end', () => {
    const ticks = dateTicks(days('2024-09-26', 731), 5, false, 'en-GB');
    expect(labels(ticks)).toEqual(['26 Sept 2024', 'Jul', '26 Sept 2026']);
    expect(ticks.map((tick) => tick.index)).toEqual([0, 278, 730]);
  });

  it('marks a month in days, the year only at the ends', () => {
    const ticks = labels(dateTicks(days('2026-08-26', 32), 6, false, 'en-GB'));
    expect(ticks[0]).toBe('26 Aug 2026');
    expect(ticks[ticks.length - 1]).toBe('26 Sept 2026');
    // About a week apart, and clear of the ends' longer labels.
    expect(ticks.slice(1, -1)).toEqual(['5 Sept', '11 Sept', '16 Sept']);
  });

  it('leaves out a day that rounding would carry onto an end', () => {
    // Six weekly columns on a phone: the one middle label rounded onto "21 Sept 2026".
    const weeks = [
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ];
    expect(labels(dateTicks(weeks, 4, false, 'en-GB'))).toEqual(['17 Aug 2026', '21 Sept 2026']);
  });

  it('names monthly columns by month, the ends with their year', () => {
    const months = Array.from({ length: 25 }, (_, n) =>
      new Date(Date.UTC(2024, 8 + n, 1)).toISOString().slice(0, 10),
    );
    expect(labels(dateTicks(months, 5, true, 'en-GB'))).toEqual(['Sept 2024', 'Jul', 'Sept 2026']);
  });

  it('has one label for one day, and none for none', () => {
    expect(labels(dateTicks(['2026-09-26'], 10, false, 'en-GB'))).toEqual(['26 Sept 2026']);
    expect(dateTicks([], 10, false, 'en-GB')).toEqual([]);
  });
});
