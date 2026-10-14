import { describe, expect, it } from 'vitest';

import type { CategoryRow, ChoiceRow, Entry, RuleRow } from './budgets.ts';
import {
  byDay,
  describeWeekday,
  findCategories,
  findRules,
  lastDays,
  nextToSort,
  offersRule,
  recentCategories,
  rulesMadeIn,
  rulesNewestFirst,
} from './sorting.ts';

const AT = '2026-09-25T09:00:00+00:00';

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

function choice(id: string, categoryId: string, at: string, deleted = false): ChoiceRow {
  return {
    id,
    updated_at: at,
    deleted_at: deleted ? at : null,
    transaction_id: `t-${id}`,
    category_id: categoryId,
  };
}

function rule(
  payee: string,
  categoryId: string | null,
  startsOn: string,
  createdAt: string = AT,
): RuleRow {
  return {
    id: `${payee}-${startsOn}`,
    updated_at: AT,
    deleted_at: null,
    payee,
    category_id: categoryId,
    starts_on: startsOn,
    created_at: createdAt,
  };
}

function entry(id: string, day: string): Entry {
  return {
    transaction: {
      id,
      updated_at: AT,
      deleted_at: null,
      account_id: 'card',
      posted_at: `${day}T12:00:00+00:00`,
      transacted_at: null,
      amount_minor: -100,
      payee: 'Whole Foods',
      description: '',
      source_category: null,
      pending: false,
    },
    currency: 'USD',
    day,
    filed: { kind: 'none' },
  };
}

const food = category('food', 'Groceries');
const eat = category('eat', 'Eating out');
const cafe = category('cafe', 'Café');
const home = category('home', 'Home');
const gone = category('gone', 'Garden', { deleted_at: AT });

describe('recent choices', () => {
  it('lists the categories of her newest choices first, each once', () => {
    const choices = [
      choice('a', 'food', '2026-09-20T10:00:00Z'),
      choice('b', 'eat', '2026-09-24T10:00:00Z'),
      choice('c', 'food', '2026-09-25T10:00:00Z'),
      choice('d', 'home', '2026-09-01T10:00:00Z'),
    ];
    expect(recentCategories(choices, [food, eat, home], 5).map((c) => c.id)).toEqual([
      'food',
      'eat',
      'home',
    ]);
    expect(recentCategories(choices, [food, eat, home], 2).map((c) => c.id)).toEqual([
      'food',
      'eat',
    ]);
  });

  it('leaves out a choice taken back and a category removed', () => {
    const choices = [
      choice('a', 'eat', '2026-09-25T10:00:00Z', true),
      choice('b', 'gone', '2026-09-24T10:00:00Z'),
      choice('c', 'food', '2026-09-20T10:00:00Z'),
    ];
    expect(recentCategories(choices, [food, eat, gone], 5).map((c) => c.id)).toEqual(['food']);
  });

  it('breaks a tie between choices made at the same moment by id, so every device agrees', () => {
    const choices = [choice('a', 'food', AT), choice('b', 'eat', AT)];
    expect(recentCategories(choices, [food, eat], 5).map((c) => c.id)).toEqual(['eat', 'food']);
  });
});

describe('finding a category', () => {
  const all = [food, eat, cafe, home, gone];

  it('lists every listed category by name for nothing typed', () => {
    expect(findCategories('  ', all).map((c) => c.name)).toEqual([
      'Café',
      'Eating out',
      'Groceries',
      'Home',
    ]);
  });

  it('puts names that start with what is typed before names that hold it', () => {
    expect(findCategories('e', all).map((c) => c.name)).toEqual([
      'Eating out',
      'Café',
      'Groceries',
      'Home',
    ]);
    expect(findCategories('out', all).map((c) => c.name)).toEqual(['Eating out']);
  });

  it('ignores case and accents, and never finds a removed category', () => {
    expect(findCategories('CAFE', all).map((c) => c.id)).toEqual(['cafe']);
    expect(findCategories('garden', all)).toEqual([]);
  });
});

describe('days', () => {
  it('puts entries under one heading per day, in their order', () => {
    const days = byDay([
      entry('a', '2026-09-24'),
      entry('b', '2026-09-24'),
      entry('c', '2026-09-20'),
    ]);
    expect(days.map((d) => [d.day, d.entries.map((e) => e.transaction.id)])).toEqual([
      ['2026-09-24', ['a', 'b']],
      ['2026-09-20', ['c']],
    ]);
    expect(byDay([])).toEqual([]);
  });

  it('keeps the week back from the newest entry, not from today', () => {
    const entries = [entry('a', '2026-08-31'), entry('b', '2026-08-25'), entry('c', '2026-08-24')];
    expect(lastDays(entries, 7).map((e) => e.transaction.id)).toEqual(['a', 'b']);
  });

  it('crosses the start of a month, and is nothing for nothing', () => {
    expect(lastDays([entry('a', '2026-09-02'), entry('b', '2026-08-27')], 7)).toHaveLength(2);
    expect(lastDays([], 7)).toEqual([]);
  });

  it('names a day with its weekday and without its year', () => {
    expect(describeWeekday('2026-09-24', 'en-US')).toBe('Thu, Sep 24');
  });
});

describe('the rule question', () => {
  it('is asked for a category chosen for a payee', () => {
    expect(offersRule(eat, 'square *odd', [], '2026-09')).toBe(true);
  });

  it('is not asked for taking a choice away, or for a transaction with no payee', () => {
    expect(offersRule(null, 'square *odd', [], '2026-09')).toBe(false);
    expect(offersRule(eat, '', [], '2026-09')).toBe(false);
  });

  it('is not asked when the rule in force already files it there, and is for another', () => {
    const rules = [rule('square *odd', 'eat', '2026-08-01')];
    expect(offersRule(eat, 'square *odd', rules, '2026-09')).toBe(false);
    expect(offersRule(food, 'square *odd', rules, '2026-09')).toBe(true);
  });

  it('is asked again once the rule has stopped', () => {
    const rules = [
      rule('square *odd', 'eat', '2026-08-01'),
      rule('square *odd', null, '2026-09-01'),
    ];
    expect(offersRule(eat, 'square *odd', rules, '2026-09')).toBe(true);
  });
});

describe('the Unsorted queue', () => {
  const queue = ['a', 'b', 'c', 'd'];

  it('goes to the next one still unsorted, passing over one a rule sorted', () => {
    const left = new Set(['a', 'c', 'd']);
    expect(nextToSort(queue, 0, (id) => left.has(id))).toBe(2);
  });

  it('comes back round to one skipped', () => {
    const left = new Set(['a']);
    expect(nextToSort(queue, 2, (id) => left.has(id))).toBe(0);
  });

  it('is done once none is left, the one it is on included', () => {
    expect(nextToSort(queue, 1, () => false)).toBeNull();
    expect(nextToSort(['a'], 0, () => true)).toBeNull();
    expect(nextToSort([], 0, () => true)).toBeNull();
  });
});

describe('rules, when there are hundreds', () => {
  const rules = [
    rule('mercadona', 'food', '2026-09-01', '2026-09-20T10:00:00+00:00'),
    rule('café de flore', 'eat', '2026-09-01', '2026-09-22T10:00:00+00:00'),
    rule('safeway', 'food', '2026-07-01', '2026-07-03T10:00:00+00:00'),
    // Stopped this month: not in force, so not listed.
    rule('netflix', 'subs', '2026-06-01', '2026-06-02T10:00:00+00:00'),
    { ...rule('netflix', null, '2026-09-01', '2026-09-10T10:00:00+00:00'), id: 'netflix-stop' },
  ];

  it('lists those in force, the newest made first', () => {
    expect(rulesNewestFirst('2026-09', rules).map((r) => r.payee)).toEqual([
      'café de flore',
      'mercadona',
      'safeway',
    ]);
  });

  it('breaks a tie by the month it starts, then by payee', () => {
    const tied = [
      rule('b', 'x', '2026-08-01'),
      rule('a', 'x', '2026-08-01'),
      rule('c', 'x', '2026-09-01'),
    ];
    expect(rulesNewestFirst('2026-09', tied).map((r) => r.payee)).toEqual(['c', 'a', 'b']);
  });

  it('finds a rule by any part of its payee, accents and case aside', () => {
    const live = rulesNewestFirst('2026-09', rules);
    expect(findRules('CAFE', null, live).map((r) => r.payee)).toEqual(['café de flore']);
    expect(findRules('  ', null, live)).toHaveLength(3);
    expect(findRules('', 'food', live).map((r) => r.payee)).toEqual(['mercadona', 'safeway']);
    expect(findRules('way', 'food', live).map((r) => r.payee)).toEqual(['safeway']);
    expect(findRules('way', 'eat', live)).toEqual([]);
  });

  it('counts the rules made in a month', () => {
    expect(rulesMadeIn('2026-09', rulesNewestFirst('2026-09', rules))).toBe(2);
    expect(rulesMadeIn('2026-08', rules)).toBe(0);
  });
});
