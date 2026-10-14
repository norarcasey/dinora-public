import { describe, expect, it } from 'vitest';

import type { BudgetRow, CategoryRow, ChoiceRow, SpendLine, TransactionRow } from './budgets.ts';
import { entriesIn, makeFiler, summarise } from './budgets.ts';
import type { History, MonthClock } from './pace.ts';
import {
  averageSpent,
  byAttention,
  categoriesInUse,
  evenPace,
  laidAlong,
  monthClock,
  spentBefore,
  spentByDay,
  standingOf,
} from './pace.ts';
import type { RateRow } from './rates.ts';

const AT = '2026-09-25T09:00:00+00:00';
const TODAY = '2026-09-25';

function category(id: string, name: string, overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name,
    kind: 'spend',
    guesses_from: [],
    created_at: AT,
    ...overrides,
  };
}

function budgetRow(categoryId: string, minor: number): BudgetRow {
  return {
    id: `b-${categoryId}`,
    updated_at: AT,
    deleted_at: null,
    category_id: categoryId,
    starts_on: '2026-01-01',
    amount_minor: minor,
    currency: 'USD',
  };
}

function line(name: string, spent: bigint | null, budget: number | null): SpendLine {
  const c = category(name.toLowerCase(), name);
  return {
    category: c,
    count: 1,
    spent:
      spent === null ? { kind: 'unrated', missing: ['EUR'] } : { kind: 'summed', minor: spent },
    budget: budget === null ? null : { row: budgetRow(c.id, budget), amountMinor: budget },
    budgetMinor: budget === null ? null : BigInt(budget),
  };
}

function txn(id: string, on: string, minor: number, source: string | null): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: 'card',
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee: 'Somewhere',
    description: '',
    source_category: source,
    pending: false,
  };
}

const RUNNING: MonthClock = { elapsed: 833, daysLeft: 5, running: true };
const OVER: MonthClock = { elapsed: 1000, daysLeft: 0, running: false };

describe('monthClock', () => {
  it('counts today as gone in the month that holds it', () => {
    expect(monthClock('2026-09', '2026-09-25')).toEqual({
      elapsed: 833,
      daysLeft: 5,
      running: true,
    });
    expect(monthClock('2026-09', '2026-09-30')).toEqual({
      elapsed: 1000,
      daysLeft: 0,
      running: true,
    });
    expect(monthClock('2026-02', '2026-02-01').elapsed).toBe(35);
  });

  it('has a month before today wholly gone, and one after not begun', () => {
    expect(monthClock('2026-08', TODAY)).toEqual(OVER);
    expect(monthClock('2026-10', TODAY)).toEqual({ elapsed: 0, daysLeft: 31, running: false });
  });
});

describe('standingOf', () => {
  it('is over past the budget, ahead past the pace, on track otherwise', () => {
    expect(standingOf(30_100n, 30_000n, RUNNING)).toBe('over');
    expect(standingOf(28_000n, 30_000n, RUNNING)).toBe('ahead');
    expect(standingOf(20_000n, 30_000n, RUNNING)).toBe('on-track');
    expect(standingOf(30_000n, 30_000n, RUNNING)).toBe('ahead');
  });

  it('is never ahead of a month that is over, and nothing is ahead of a budget of nothing', () => {
    expect(standingOf(29_000n, 30_000n, OVER)).toBe('on-track');
    expect(standingOf(0n, 0n, RUNNING)).toBe('on-track');
    expect(standingOf(1n, 0n, RUNNING)).toBe('over');
  });
});

describe('byAttention', () => {
  it('puts the most over first, then the furthest ahead, then the closest to its budget', () => {
    const placed = byAttention(
      [
        line('Shopping', 31_800n, 30_000),
        line('Dining', 41_200n, 30_000),
        line('Gas', 18_500n, 20_000),
        line('Groceries', 56_000n, 60_000),
        line('Home', 24_000n, 40_000),
        line('Travel', 12_000n, 50_000),
        line('Pets', 11_000n, null),
        line('Abroad', null, 10_000),
        line('Gifts', 6_400n, null),
      ],
      RUNNING,
    );
    const names = (list: readonly { line: SpendLine }[]) => list.map((p) => p.line.category.name);
    expect(names(placed.over)).toEqual(['Dining', 'Shopping']);
    expect(names(placed.ahead)).toEqual(['Groceries', 'Gas']);
    expect(names(placed.onTrack)).toEqual(['Home', 'Travel', 'Abroad']);
    expect(placed.onTrack.at(-1)).toMatchObject({ standing: null, share: null });
    expect(placed.unbudgeted.map((l) => l.category.name)).toEqual(['Pets', 'Gifts']);
  });

  it('orders ties by name', () => {
    const placed = byAttention(
      [
        line('B', 40_000n, 30_000),
        line('A', 40_000n, 30_000),
        line('D', 10_000n, 30_000),
        line('C', 10_000n, 30_000),
      ],
      RUNNING,
    );
    expect(placed.over.map((p) => p.line.category.name)).toEqual(['A', 'B']);
    expect(placed.onTrack.map((p) => p.line.category.name)).toEqual(['C', 'D']);
  });
});

describe('spentBefore', () => {
  const food = category('food', 'Groceries', { guesses_from: ['Groceries'] });
  const history = (transactions: TransactionRow[]): History => ({
    transactions,
    counted: new Map([['card', 'USD']]),
    file: makeFiler([food], [], [], TODAY),
    categories: [food],
    budgets: [budgetRow('food', 60_000)],
    rates: [],
    today: TODAY,
  });

  it('sums each month before, the nearest first, and a month with nothing as nothing', () => {
    const past = spentBefore(
      'food',
      '2026-09',
      3,
      history([
        txn('a1', '2026-08-02', -30_000, 'Groceries'),
        txn('a2', '2026-08-20', -31_200, 'Groceries'),
        txn('j1', '2026-07-09', -57_500, 'Groceries'),
        txn('s1', '2026-09-03', -99_999, 'Groceries'),
        txn('x1', '2026-06-01', -5_000, null),
      ]),
    );
    expect(past).toEqual([
      { month: '2026-08', spent: { kind: 'summed', minor: 61_200n } },
      { month: '2026-07', spent: { kind: 'summed', minor: 57_500n } },
      { month: '2026-06', spent: { kind: 'summed', minor: 0n } },
    ]);
    expect(averageSpent(past)).toBe(39_567n);
  });

  it('averages only what can be worked out, and no refunds below nothing', () => {
    expect(averageSpent([])).toBeNull();
    expect(
      averageSpent([
        { month: '2026-08', spent: { kind: 'summed', minor: 100n } },
        { month: '2026-07', spent: { kind: 'unrated', missing: ['EUR'] } },
      ]),
    ).toBeNull();
    expect(
      averageSpent([
        { month: '2026-08', spent: { kind: 'summed', minor: -500n } },
        { month: '2026-07', spent: { kind: 'summed', minor: 101n } },
      ]),
    ).toBe(51n);
  });
});

describe('categoriesInUse', () => {
  it('names each category anything live is filed under', () => {
    const food = category('food', 'Groceries', { guesses_from: ['Groceries'] });
    const eat = category('eat', 'Eating out');
    const school = category('school', 'Education');
    const choice: ChoiceRow = {
      id: 'c',
      updated_at: AT,
      deleted_at: null,
      transaction_id: 'mine',
      category_id: 'eat',
    };
    const file = makeFiler([food, eat, school], [choice], [], TODAY);
    const used = categoriesInUse(
      [
        txn('wf', '2024-03-02', -100, 'Groceries'),
        txn('mine', '2026-09-02', -100, null),
        txn('none', '2026-09-02', -100, null),
        { ...txn('gone', '2026-09-02', -100, 'Education'), deleted_at: AT },
      ],
      file,
    );
    expect([...used].sort()).toEqual(['eat', 'food']);
  });
});

describe('spentByDay', () => {
  const food = category('food', 'Groceries', { guesses_from: ['Groceries'] });
  const pay = category('pay', 'Paycheck', { kind: 'income', guesses_from: ['Paycheck'] });
  const categories = [food, pay];
  const file = makeFiler(categories, [], [], TODAY);
  const counted = new Map([
    ['card', 'USD'],
    ['ejemplo', 'EUR'],
  ]);
  const rate: RateRow = {
    id: 'r',
    updated_at: AT,
    deleted_at: null,
    source: 'ecb',
    base: 'EUR',
    quote: 'USD',
    rate_date: '2026-07-31',
    rate: '1.1111',
  };
  const inEuros = (t: TransactionRow): TransactionRow => ({ ...t, account_id: 'ejemplo' });

  it('starts at nothing, adds each day, and stops at today in a running month', () => {
    const entries = entriesIn(
      '2026-09',
      [
        txn('a', '2026-09-02', -1_000, 'Groceries'),
        txn('b', '2026-09-02', -500, 'Groceries'),
        txn('r', '2026-09-04', 200, 'Groceries'),
        txn('p', '2026-09-03', 900_000, 'Paycheck'),
        txn('u', '2026-09-03', -7_000, null),
      ],
      counted,
      file,
      TODAY,
    );
    const line = spentByDay('2026-09', entries, categories, [], TODAY);
    expect(line).toHaveLength(26);
    // A refund takes back; a paycheck and anything uncategorized are not spending.
    expect(line.slice(0, 5)).toEqual([0n, 0n, 1_500n, 1_500n, 1_300n]);
    expect(line[25]).toBe(1_300n);
  });

  it('ends at the month’s own figure to the cent, however many days its euros came on', () => {
    const transactions = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      inEuros(txn(`e${n}`, `2026-08-0${n}`, -335, 'Groceries')),
    );
    const entries = entriesIn('2026-08', transactions, counted, file, TODAY);
    const line = spentByDay('2026-08', entries, categories, [rate], TODAY);
    const summary = summarise('2026-08', entries, categories, [], [rate], TODAY);
    expect(line).toHaveLength(32);
    expect(line[31]).toBe(summary.spentMinor);
    // €3.35 is $3.72 a day, seven days $26.04; €23.45 at once is $26.06, which the page shows.
    expect(summary.spentMinor).toBe(2_606n);
  });

  it('says nothing for a day whose euros have no rate', () => {
    const entries = entriesIn(
      '2026-08',
      [inEuros(txn('e', '2026-08-03', -333, 'Groceries'))],
      counted,
      file,
      TODAY,
    );
    const line = spentByDay('2026-08', entries, categories, [], TODAY);
    expect(line.slice(0, 5)).toEqual([0n, 0n, 0n, null, null]);
  });

  it('has only its start for a month not begun', () => {
    expect(spentByDay('2026-10', [], categories, [], TODAY)).toEqual([0n]);
  });
});

describe('laidAlong', () => {
  it('folds a longer month’s last days into the end', () => {
    expect(laidAlong([0n, 1n, 2n, 3n, 4n], 3)).toEqual([0n, 1n, 2n, 4n]);
  });

  it('holds a shorter month’s total past its end', () => {
    expect(laidAlong([0n, 1n, 2n], 4)).toEqual([0n, 1n, 2n, 2n, 2n]);
  });
});

describe('evenPace', () => {
  it('goes from nothing to the budget in a straight line, to the nearest cent', () => {
    expect(evenPace(60_000n, 0, 30)).toBe(0n);
    expect(evenPace(60_000n, 10, 30)).toBe(20_000n);
    expect(evenPace(100n, 1, 3)).toBe(33n);
    expect(evenPace(100n, 2, 3)).toBe(67n);
    expect(evenPace(60_000n, 30, 30)).toBe(60_000n);
  });
});
