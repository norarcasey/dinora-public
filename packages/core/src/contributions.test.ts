import { describe, expect, it } from 'vitest';

import type { CategoryRow, ChoiceRow, TransactionRow } from './budgets.ts';
import { entriesIn, makeFiler, summarise } from './budgets.ts';
import type { GoalPlanRow } from './contributions.ts';
import {
  compareGoalPlans,
  contributionsIn,
  givenShare,
  goalMonth,
  goalPlanRowSchema,
  goalsIn,
  planFor,
  planRowIn,
} from './contributions.ts';
import type { GoalAccountRow, GoalRow } from './goals.ts';
import type { RateRow } from './rates.ts';
import { pairTransfers } from './transfers.ts';

const TODAY = '2026-09-25';
const AT = '2026-09-25T09:00:00+00:00';

const CURRENCIES = new Map([
  ['checking', 'USD'],
  ['savings', 'USD'],
  ['savings-2', 'USD'],
  ['visa', 'USD'],
  ['amex', 'USD'],
  ['castellana', 'EUR'],
]);

function txn(
  id: string,
  account: string,
  on: string,
  minor: number,
  overrides: Partial<TransactionRow> = {},
): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: account,
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee: null,
    description: id,
    source_category: null,
    pending: false,
    ...overrides,
  };
}

function category(id: string, kind: CategoryRow['kind']): CategoryRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name: id,
    kind,
    guesses_from: [],
    created_at: AT,
  };
}

function choice(transactionId: string, categoryId: string): ChoiceRow {
  return {
    id: `c-${transactionId}`,
    updated_at: AT,
    deleted_at: null,
    transaction_id: transactionId,
    category_id: categoryId,
  };
}

function goal(id: string, overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name: id,
    kind: 'payoff',
    currency: 'USD',
    target_minor: null,
    starts_on: '2026-01-01',
    target_on: null,
    created_at: AT,
    ...overrides,
  };
}

function link(goalId: string, accountId: string, deleted: string | null = null): GoalAccountRow {
  return {
    id: `${goalId}-${accountId}`,
    updated_at: AT,
    deleted_at: deleted,
    goal_id: goalId,
    account_id: accountId,
  };
}

function plan(
  goalId: string,
  startsOn: string,
  minor: number | null,
  overrides: Partial<GoalPlanRow> = {},
): GoalPlanRow {
  return {
    id: `${goalId}-${startsOn}`,
    updated_at: AT,
    deleted_at: null,
    goal_id: goalId,
    starts_on: startsOn,
    amount_minor: minor,
    ...overrides,
  };
}

const EUR_USD: RateRow = {
  id: 'rate-1',
  updated_at: AT,
  deleted_at: null,
  base: 'EUR',
  quote: 'USD',
  rate: '1.1',
  rate_date: '2026-09-24',
  source: 'ecb',
};

const CATEGORIES = [
  category('groceries', 'spend'),
  category('pay', 'income'),
  category('transfers', 'transfer'),
];

/** Filed and paired as the Budget tab files them. */
function setUp(transactions: readonly TransactionRow[], choices: readonly ChoiceRow[] = []) {
  const pairs = pairTransfers(transactions, CURRENCIES, TODAY);
  const file = makeFiler(CATEGORIES, choices, [], TODAY, pairs);
  return { pairs, file };
}

describe('the plan', () => {
  const plans = [
    plan('cards', '2026-07-01', 100_000),
    plan('cards', '2026-09-01', 150_000),
    plan('cards', '2026-11-01', null),
    plan('cards', '2026-10-01', 999, { deleted_at: AT }),
    plan('other', '2026-01-01', 5),
  ];

  it('is the newest row starting on or before the month', () => {
    expect(planFor('cards', '2026-06', plans)).toBeNull();
    expect(planFor('cards', '2026-08', plans)?.amountMinor).toBe(100_000);
    expect(planFor('cards', '2026-09', plans)?.amountMinor).toBe(150_000);
    expect(planFor('cards', '2026-10', plans)?.amountMinor).toBe(150_000);
  });

  it('stops where a row says none from then', () => {
    expect(planFor('cards', '2026-11', plans)).toBeNull();
    expect(planFor('cards', '2027-03', plans)).toBeNull();
  });

  it('finds the row a change from this month edits, and only a live one', () => {
    expect(planRowIn('cards', '2026-09', plans)?.amount_minor).toBe(150_000);
    expect(planRowIn('cards', '2026-10', plans)).toBeNull();
    expect(planRowIn('cards', '2026-08', plans)).toBeNull();
  });

  it('sorts by goal, then month', () => {
    const sorted = [...plans].sort(compareGoalPlans).map((p) => p.id);
    expect(sorted.slice(0, 3)).toEqual([
      'cards-2026-07-01',
      'cards-2026-09-01',
      'cards-2026-10-01',
    ]);
    expect(sorted.at(-1)).toBe('other-2026-01-01');
  });

  it('parses as PostgREST sends it, and refuses a plan below zero', () => {
    expect(goalPlanRowSchema.safeParse(plan('g', '2026-09-01', 0)).success).toBe(true);
    expect(goalPlanRowSchema.safeParse(plan('g', '2026-09-01', null)).success).toBe(true);
    expect(goalPlanRowSchema.safeParse(plan('g', '2026-09-01', -1)).success).toBe(false);
  });
});

describe('what a goal was given', () => {
  // Nora's card payoff: two cards, each paid from checking; new charges on both.
  const cardPayoff = [
    txn('pay-visa-out', 'checking', '2026-09-10', -200_000),
    txn('pay-visa-in', 'visa', '2026-09-12', 200_000),
    txn('pay-amex-out', 'checking', '2026-09-15', -50_000),
    txn('pay-amex-in', 'amex', '2026-09-16', 50_000),
    txn('groceries-visa', 'visa', '2026-09-13', -180_000, { source_category: null }),
    txn('refund-amex', 'amex', '2026-09-20', 3_000),
  ];

  it('is the money moved into its accounts, not how far the balance moved', () => {
    const { pairs, file } = setUp(cardPayoff, [
      choice('groceries-visa', 'groceries'),
      choice('refund-amex', 'groceries'),
    ]);
    const month = goalMonth(
      goal('cards'),
      '2026-09',
      [link('cards', 'visa'), link('cards', 'amex')],
      cardPayoff,
      CURRENCIES,
      file,
      pairs,
      [],
      [],
      TODAY,
    );
    // $2,000 and $500 paid; the $1,800 of groceries and the $30 refund are not contributions.
    expect(month.given).toEqual({ kind: 'summed', minor: 250_000n });
    expect(month.contributions.map((c) => c.transaction.id)).toEqual([
      'pay-amex-in',
      'pay-visa-in',
    ]);
    expect(month.contributions[0]?.partner?.id).toBe('pay-amex-out');
  });

  it('counts each dollar once: a transfer on the budget, a contribution on the goal', () => {
    const { pairs, file } = setUp(cardPayoff, [
      choice('groceries-visa', 'groceries'),
      choice('refund-amex', 'groceries'),
    ]);
    const spending = new Map([
      ['checking', 'USD'],
      ['visa', 'USD'],
      ['amex', 'USD'],
    ]);
    const summary = summarise(
      '2026-09',
      entriesIn('2026-09', cardPayoff, spending, file, TODAY),
      CATEGORIES,
      [],
      [],
      TODAY,
    );
    // The budget counts the groceries less the refund, and neither side of either payment.
    expect(summary.spentMinor).toBe(177_000n);
    expect(summary.transfers.map((line) => line.count)).toEqual([4]);
    const month = goalMonth(
      goal('cards'),
      '2026-09',
      [link('cards', 'visa'), link('cards', 'amex')],
      cardPayoff,
      CURRENCIES,
      file,
      pairs,
      [],
      [],
      TODAY,
    );
    expect(month.given).toEqual({ kind: 'summed', minor: 250_000n });
  });

  it('counts money taken back out of a goal as below zero', () => {
    const moves = [
      txn('save-out', 'checking', '2026-09-01', -100_000),
      txn('save-in', 'savings', '2026-09-01', 100_000),
      txn('spend-out', 'savings', '2026-09-20', -30_000),
      txn('spend-in', 'checking', '2026-09-21', 30_000),
    ];
    const { pairs, file } = setUp(moves);
    const month = goalMonth(
      goal('fund', { kind: 'save', target_minor: 1_000_000 }),
      '2026-09',
      [link('fund', 'savings')],
      moves,
      CURRENCIES,
      file,
      pairs,
      [],
      [],
      TODAY,
    );
    expect(month.given).toEqual({ kind: 'summed', minor: 70_000n });
  });

  it('counts nothing for a move between two of the goal’s own accounts', () => {
    const moves = [
      txn('inside-out', 'savings', '2026-09-05', -40_000),
      txn('inside-in', 'savings-2', '2026-09-06', 40_000),
    ];
    const { pairs, file } = setUp(moves);
    const found = contributionsIn(
      '2026-09',
      new Set(['savings', 'savings-2']),
      moves,
      CURRENCIES,
      file,
      pairs,
      TODAY,
    );
    expect(found).toEqual([]);
  });

  it('counts a side she filed as a transfer though its other side was never found', () => {
    const moves = [
      txn('from-venmo', 'savings', '2026-09-08', 25_000),
      txn('interest', 'savings', '2026-09-30', 120),
    ];
    const { pairs, file } = setUp(moves, [
      choice('from-venmo', 'transfers'),
      choice('interest', 'pay'),
    ]);
    const found = contributionsIn(
      '2026-09',
      new Set(['savings']),
      moves,
      CURRENCIES,
      file,
      pairs,
      TODAY,
    );
    // Interest is income, not money she gave it.
    expect(found.map((c) => [c.transaction.id, c.partner])).toEqual([['from-venmo', null]]);
  });

  it('counts no pair she has said is no transfer', () => {
    const moves = [
      txn('purchase', 'visa', '2026-09-03', -5_000),
      txn('return', 'amex', '2026-09-04', 5_000),
    ];
    const { pairs, file } = setUp(moves, [choice('return', 'groceries')]);
    const found = contributionsIn(
      '2026-09',
      new Set(['amex']),
      moves,
      CURRENCIES,
      file,
      pairs,
      TODAY,
    );
    expect(found).toEqual([]);
  });

  it('reads only the month, the goal’s live links and live transactions', () => {
    const moves = [
      txn('august-out', 'checking', '2026-08-30', -10_000),
      txn('august-in', 'savings', '2026-08-31', 10_000),
      txn('gone-out', 'checking', '2026-09-02', -20_000),
      txn('gone-in', 'savings', '2026-09-02', 20_000, { deleted_at: AT }),
      txn('old-link-out', 'checking', '2026-09-03', -30_000),
      txn('old-link-in', 'savings-2', '2026-09-03', 30_000),
      txn('nothing', 'savings', '2026-09-04', 0),
      txn('unknown-account', 'elsewhere', '2026-09-04', 1_000),
    ];
    const { pairs, file } = setUp(moves, [
      choice('nothing', 'transfers'),
      choice('unknown-account', 'transfers'),
    ]);
    const month = goalMonth(
      goal('fund', { kind: 'save', target_minor: 1_000_000 }),
      '2026-09',
      [link('fund', 'savings'), link('fund', 'savings-2', AT), link('fund', 'elsewhere')],
      moves,
      CURRENCIES,
      file,
      pairs,
      [],
      [],
      TODAY,
    );
    expect(month.contributions).toEqual([]);
    expect(month.given).toEqual({ kind: 'summed', minor: 0n });
  });

  it('converts each currency at one stored rate, and says which', () => {
    const moves = [
      txn('usd', 'savings', '2026-09-02', 10_000),
      txn('eur', 'castellana', '2026-09-03', 10_000),
    ];
    const { pairs, file } = setUp(moves, [choice('usd', 'transfers'), choice('eur', 'transfers')]);
    const month = goalMonth(
      goal('fund', { kind: 'save', target_minor: 1_000_000 }),
      '2026-09',
      [link('fund', 'savings'), link('fund', 'castellana')],
      moves,
      CURRENCIES,
      file,
      pairs,
      [plan('fund', '2026-09-01', 50_000)],
      [EUR_USD],
      TODAY,
    );
    expect(month.given).toEqual({ kind: 'summed', minor: 21_000n });
    expect(month.ratesOn).toBe(TODAY);
    expect(month.conversions.map((c) => [c.currency, c.rate.rate_date])).toEqual([
      ['EUR', '2026-09-24'],
    ]);
    expect(month.plan?.amountMinor).toBe(50_000);
  });

  it('says so when a currency has no rate yet, and a past month reads its last day’s', () => {
    const moves = [txn('eur', 'castellana', '2026-08-03', 10_000)];
    const { pairs, file } = setUp(moves, [choice('eur', 'transfers')]);
    const month = goalMonth(
      goal('fund', { kind: 'save', target_minor: 1_000_000 }),
      '2026-08',
      [link('fund', 'castellana')],
      moves,
      CURRENCIES,
      file,
      pairs,
      [],
      [],
      TODAY,
    );
    expect(month.given).toEqual({ kind: 'unrated', missing: ['EUR'] });
    expect(month.ratesOn).toBe('2026-08-31');
    expect(month.conversions).toEqual([]);
  });

  it('lists every live goal in the order she made them', () => {
    const { pairs, file } = setUp([]);
    const goals = [
      goal('second', { created_at: '2026-09-02T00:00:00+00:00' }),
      goal('first', { created_at: '2026-09-01T00:00:00+00:00' }),
      goal('given-up', { deleted_at: AT }),
    ];
    const months = goalsIn('2026-09', goals, [], [], CURRENCIES, file, pairs, [], [], TODAY);
    expect(months.map((m) => m.goal.id)).toEqual(['first', 'second']);
  });
});

describe('a share of the plan', () => {
  it('is tenths of a percent, from zero, past 1000 once over', () => {
    expect(givenShare(50_000n, 100_000)).toBe(500);
    expect(givenShare(150_000n, 100_000)).toBe(1500);
    expect(givenShare(-1n, 100_000)).toBe(0);
    expect(givenShare(0n, 100_000)).toBe(0);
  });

  it('is none with a plan of nothing', () => {
    expect(givenShare(10n, 0)).toBeNull();
  });
});
