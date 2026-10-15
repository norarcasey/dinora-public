import { describe, expect, it } from 'vitest';

import type {
  BudgetRow,
  CategoryRow,
  ChoiceRow,
  Filed,
  RuleRow,
  TransactionRow,
} from './budgets.ts';
import {
  budgetFor,
  budgetRowIn,
  budgetRowSchema,
  categoryRowSchema,
  compareBudgets,
  compareCategories,
  compareChoices,
  compareRules,
  compareTransactions,
  dayOf,
  describeMonth,
  entriesIn,
  firstDayOf,
  guessKind,
  lastDayOf,
  makeFiler,
  monthOf,
  normalisePayee,
  payeeName,
  payeeOf,
  rulesIn,
  shiftMonth,
  spentShare,
  startingCategories,
  summarise,
  transactionRowSchema,
  unclaimedSources,
} from './budgets.ts';
import type { RateRow } from './rates.ts';

const TODAY = '2026-09-25';
const AT = '2026-09-25T09:00:00+00:00';

function category(
  id: string,
  name: string,
  kind: CategoryRow['kind'] = 'spend',
  overrides: Partial<CategoryRow> = {},
): CategoryRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name,
    kind,
    guesses_from: [],
    created_at: AT,
    ...overrides,
  };
}

function txn(
  id: string,
  on: string | null,
  minor: number,
  overrides: Partial<TransactionRow> = {},
): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: 'card',
    posted_at: on === null ? null : `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee: 'Whole Foods',
    description: 'WHOLEFDS SDG 10234',
    source_category: null,
    pending: false,
    ...overrides,
  };
}

function choice(transactionId: string, categoryId: string, id = `c-${transactionId}`): ChoiceRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    transaction_id: transactionId,
    category_id: categoryId,
  };
}

function rule(
  id: string,
  payee: string,
  categoryId: string | null,
  startsOn: string,
  overrides: Partial<RuleRow> = {},
): RuleRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    payee,
    category_id: categoryId,
    starts_on: startsOn,
    created_at: AT,
    ...overrides,
  };
}

function budget(
  categoryId: string,
  startsOn: string,
  minor: number | null,
  overrides: Partial<BudgetRow> = {},
): BudgetRow {
  return {
    id: `${categoryId}-${startsOn}`,
    updated_at: AT,
    deleted_at: null,
    category_id: categoryId,
    starts_on: startsOn,
    amount_minor: minor,
    currency: 'USD',
    ...overrides,
  };
}

function rate(rateDate: string, value: string): RateRow {
  return {
    id: rateDate,
    updated_at: AT,
    deleted_at: null,
    source: 'ecb',
    base: 'EUR',
    quote: 'USD',
    rate_date: rateDate,
    rate: value,
  };
}

const food = category('food', 'Groceries', 'spend', { guesses_from: ['Groceries'] });
const eating = category('eat', 'Eating out', 'spend', {
  guesses_from: ['Restaurants & Bars', 'Coffee Shops'],
  created_at: '2026-09-25T10:00:00+00:00',
});
const pay = category('pay', 'Paychecks', 'income', { guesses_from: ['Paychecks'] });
const moves = category('move', 'Transfers', 'transfer', { guesses_from: ['Credit Card Payment'] });

const COUNTED = new Map([['card', 'USD']]);

function kindOf(filed: Filed): string {
  return filed.kind === 'none' ? 'none' : `${filed.kind}:${filed.category.id}`;
}

describe('the rows', () => {
  it('reads a category, a budget and a transaction as PostgREST sends them', () => {
    expect(categoryRowSchema.safeParse(food).success).toBe(true);
    expect(budgetRowSchema.safeParse(budget('food', '2026-09-01', 60_000)).success).toBe(true);
    expect(transactionRowSchema.safeParse(txn('t', '2026-09-03', -1234)).success).toBe(true);
  });

  it('refuses a negative budget and a category of no known kind', () => {
    expect(budgetRowSchema.safeParse(budget('food', '2026-09-01', -1)).success).toBe(false);
    expect(categoryRowSchema.safeParse({ ...food, kind: 'save' }).success).toBe(false);
  });

  it('orders each table the way its readers expect', () => {
    const later = category('a', 'A', 'spend', { created_at: '2026-09-26T00:00:00+00:00' });
    expect([later, food].sort(compareCategories)).toEqual([food, later]);
    expect(compareCategories(category('a', 'A'), category('b', 'B'))).toBeLessThan(0);
    const sep = budget('food', '2026-09-01', 1);
    const aug = budget('food', '2026-08-01', 1);
    expect([sep, aug].sort(compareBudgets)).toEqual([aug, sep]);
    const one = choice('t1', 'food');
    const two = choice('t2', 'food');
    expect([two, one].sort(compareChoices)).toEqual([one, two]);
    expect(compareChoices(choice('t1', 'x', 'a'), choice('t1', 'x', 'b'))).toBeLessThan(0);
    const r1 = rule('r1', 'a', 'food', '2026-09-01');
    const r2 = rule('r2', 'b', 'food', '2026-08-01');
    expect([r2, r1].sort(compareRules)).toEqual([r1, r2]);
    const old = txn('old', '2026-09-01', 1);
    const recent = txn('new', '2026-09-20', 1);
    expect([old, recent].sort(compareTransactions)).toEqual([recent, old]);
    const undated = txn('u', null, 1);
    expect([undated, old].sort(compareTransactions)).toEqual([old, undated]);
    expect(compareTransactions(txn('a', '2026-09-01', 1), txn('b', '2026-09-01', 1))).toBeLessThan(
      0,
    );
  });
});

describe('months', () => {
  it('reads a day as its month and a month as its first and last days', () => {
    expect(monthOf('2026-09-25')).toBe('2026-09');
    expect(firstDayOf('2026-09')).toBe('2026-09-01');
    expect(lastDayOf('2026-09')).toBe('2026-09-30');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(lastDayOf('2026-12')).toBe('2026-12-31');
  });

  it('steps across a year both ways', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-09', -21)).toBe('2024-12');
    expect(shiftMonth('2026-09', 0)).toBe('2026-09');
  });

  it('names a month in words', () => {
    expect(describeMonth('2026-09', 'en-US')).toBe('September 2026');
  });

  it('counts a transaction on the day it was made, else posted, else today', () => {
    const posted = txn('t', '2026-08-31', 1);
    expect(dayOf(posted, TODAY)).toBe('2026-08-31');
    expect(dayOf({ ...posted, transacted_at: '2026-08-30T23:00:00+00:00' }, TODAY)).toBe(
      '2026-08-30',
    );
    expect(dayOf(txn('p', null, 1, { pending: true }), TODAY)).toBe(TODAY);
    // Its UTC day, as the history's: 8pm in San Diego on the 31st is already September.
    expect(dayOf(txn('t', null, 1, { posted_at: '2026-08-31T20:00:00-07:00' }), TODAY)).toBe(
      '2026-09-01',
    );
  });
});

describe('payees', () => {
  it('matches a payee however the bank spaced or cased it', () => {
    expect(normalisePayee('  Whole   Foods ')).toBe('whole foods');
    expect(payeeOf(txn('t', TODAY, 1, { payee: 'WHOLE FOODS' }))).toBe('whole foods');
  });

  it('falls back to the description when the bank sends no payee', () => {
    const bare = txn('t', TODAY, 1, { payee: null, description: 'ATM  Withdrawal' });
    expect(payeeOf(bare)).toBe('atm withdrawal');
    expect(payeeName(bare)).toBe('ATM  Withdrawal');
    expect(payeeName(txn('t', TODAY, 1, { payee: null, description: ' ' }))).toBe('No payee');
    expect(payeeName(txn('t', TODAY, 1))).toBe('Whole Foods');
  });
});

describe('where a transaction is filed', () => {
  const guessed = txn('g', '2026-09-03', -500, { source_category: 'Coffee Shops' });

  it('takes her choice before anything else', () => {
    const file = makeFiler(
      [food, eating],
      [choice('g', 'food')],
      [rule('r', 'whole foods', 'eat', '2026-01-01')],
      TODAY,
    );
    const filed = file(guessed);
    expect(kindOf(filed)).toBe('chosen:food');
  });

  it('takes a rule before the aggregator’s guess', () => {
    const file = makeFiler(
      [food, eating],
      [],
      [rule('r', 'whole foods', 'food', '2026-09-01')],
      TODAY,
    );
    const filed = file(guessed);
    expect(kindOf(filed)).toBe('rule:food');
    expect(filed.kind === 'rule' && filed.rule.id).toBe('r');
  });

  it('takes the aggregator’s category as a guess, through the category that claims it', () => {
    const file = makeFiler([food, eating], [], [], TODAY);
    const filed = file(guessed);
    expect(kindOf(filed)).toBe('guess:eat');
    expect(filed.kind === 'guess' && filed.from).toBe('Coffee Shops');
  });

  it('files nothing when nothing claims it', () => {
    const file = makeFiler([food], [], [], TODAY);
    expect(file(guessed).kind).toBe('none');
    expect(file(txn('bare', TODAY, -1)).kind).toBe('none');
  });

  it('gives a name two categories claim to the older', () => {
    const newer = category('newer', 'Coffee', 'spend', {
      guesses_from: ['Coffee Shops'],
      created_at: '2026-09-26T00:00:00+00:00',
    });
    const file = makeFiler([newer, eating], [], [], TODAY);
    expect(kindOf(file(guessed))).toBe('guess:eat');
  });

  it('never applies a rule to a month before it starts', () => {
    const file = makeFiler([food], [], [rule('r', 'whole foods', 'food', '2026-09-01')], TODAY);
    expect(kindOf(file(txn('aug', '2026-08-31', -1)))).toBe('none');
    expect(kindOf(file(txn('sep', '2026-09-01', -1)))).toBe('rule:food');
  });

  it('lets the newest rule to have started govern, and a stopped one hand back to the guess', () => {
    const rules = [
      rule('sep', 'whole foods', 'food', '2026-09-01'),
      rule('oct', 'whole foods', null, '2026-10-01'),
      rule('nov', 'whole foods', 'eat', '2026-11-01'),
    ];
    const file = makeFiler([food, eating], [], rules, '2026-12-01');
    const at = (on: string) => txn(on, on, -1, { source_category: 'Groceries' });
    expect(kindOf(file(at('2026-09-15')))).toBe('rule:food');
    expect(kindOf(file(at('2026-10-15')))).toBe('guess:food');
    expect(kindOf(file(at('2026-11-15')))).toBe('rule:eat');
  });

  it('prefers the rule made last when two start in one month', () => {
    const rules = [
      rule('first', 'whole foods', 'food', '2026-09-01'),
      rule('second', 'whole foods', 'eat', '2026-09-01', {
        created_at: '2026-09-25T11:00:00+00:00',
      }),
    ];
    expect(kindOf(makeFiler([food, eating], [], rules, TODAY)(txn('t', TODAY, -1)))).toBe(
      'rule:eat',
    );
  });

  it('breaks a tie between rules made at the same moment by id, so every device agrees', () => {
    const rules = [
      rule('a', 'whole foods', 'food', '2026-09-01'),
      rule('b', 'whole foods', 'eat', '2026-09-01'),
    ];
    expect(kindOf(makeFiler([food, eating], [], rules, TODAY)(txn('t', TODAY, -1)))).toBe(
      'rule:eat',
    );
  });

  it('falls through a removed choice, rule or category', () => {
    const gone = { ...food, deleted_at: AT };
    const file = makeFiler(
      [gone, eating],
      [{ ...choice('g', 'eat'), deleted_at: AT }, choice('x', 'food')],
      [rule('r', 'whole foods', 'eat', '2026-01-01', { deleted_at: AT })],
      TODAY,
    );
    expect(kindOf(file(guessed))).toBe('guess:eat');
    // Chosen into a category since removed: filed by what comes next.
    expect(
      kindOf(file(txn('x', TODAY, -1, { payee: 'Other', source_category: 'Groceries' }))),
    ).toBe('none');
  });

  it('skips a rule whose category was removed', () => {
    const gone = { ...eating, deleted_at: AT };
    const file = makeFiler(
      [food, gone],
      [],
      [rule('r', 'whole foods', 'eat', '2026-01-01')],
      TODAY,
    );
    expect(kindOf(file(txn('t', TODAY, -1, { source_category: 'Groceries' })))).toBe('guess:food');
  });

  it('files a pending, undated transaction by today’s rules', () => {
    const file = makeFiler([food], [], [rule('r', 'whole foods', 'food', '2026-09-01')], TODAY);
    expect(kindOf(file(txn('p', null, -1, { pending: true })))).toBe('rule:food');
  });
});

describe('the rules in force', () => {
  it('lists one per payee, the newest to have started, and leaves stopped ones out', () => {
    const rules = [
      rule('a-aug', 'aldi', 'food', '2026-08-01'),
      rule('a-sep', 'aldi', 'eat', '2026-09-01'),
      rule('wf', 'whole foods', 'food', '2026-08-01'),
      rule('wf-stop', 'whole foods', null, '2026-09-01'),
      rule('later', 'zara', 'food', '2026-10-01'),
      rule('gone', 'costco', 'food', '2026-01-01', { deleted_at: AT }),
    ];
    expect(rulesIn('2026-09', rules).map((r) => r.id)).toEqual(['a-sep']);
    expect(rulesIn('2026-08', rules).map((r) => r.id)).toEqual(['a-aug', 'wf']);
  });
});

describe('the aggregator’s categories', () => {
  it('guesses a kind from Monarch’s names', () => {
    expect(guessKind('Credit Card Payment')).toBe('transfer');
    expect(guessKind('Transfer')).toBe('transfer');
    expect(guessKind('Balance Adjustments')).toBe('transfer');
    expect(guessKind('Paychecks')).toBe('income');
    expect(guessKind('Interest')).toBe('income');
    expect(guessKind('Other Income')).toBe('income');
    expect(guessKind('Groceries')).toBe('spend');
  });

  it('offers the names no category claims, most used first', () => {
    const rows = [
      txn('1', TODAY, -1, { source_category: 'Groceries' }),
      txn('2', TODAY, -1, { source_category: 'Gas' }),
      txn('3', TODAY, -1, { source_category: 'Gas' }),
      txn('4', TODAY, -1, { source_category: 'Paychecks' }),
      txn('5', TODAY, -1, { source_category: 'Gas', deleted_at: AT }),
      txn('6', TODAY, -1, { source_category: ' ' }),
      txn('7', TODAY, -1),
    ];
    const gas = category('gas', 'gas');
    const offered = unclaimedSources(rows, [food, gas]);
    expect(offered).toEqual([
      { name: 'Gas', count: 2, kind: 'spend', sameName: gas },
      { name: 'Paychecks', count: 1, kind: 'income', sameName: null },
    ]);
  });

  it('starts one category per name, folding names that differ only in case', () => {
    const offered = unclaimedSources(
      [
        txn('1', TODAY, -1, { source_category: 'Gas' }),
        txn('2', TODAY, -1, { source_category: 'Gas' }),
        txn('3', TODAY, -1, { source_category: 'GAS' }),
        txn('4', TODAY, -1, { source_category: 'Paychecks' }),
        txn('5', TODAY, -1, { source_category: 'Eating out' }),
        txn('6', TODAY, -1, { source_category: 'x'.repeat(101) }),
      ],
      [eating],
    );
    expect(startingCategories(offered)).toEqual([
      { name: 'Gas', kind: 'spend', guessesFrom: ['Gas', 'GAS'] },
      { name: 'Paychecks', kind: 'income', guessesFrom: ['Paychecks'] },
    ]);
  });

  it('offers what a removed category claimed again', () => {
    const rows = [txn('1', TODAY, -1, { source_category: 'Groceries' })];
    expect(unclaimedSources(rows, [{ ...food, deleted_at: AT }]).map((u) => u.name)).toEqual([
      'Groceries',
    ]);
  });
});

describe('a budget', () => {
  const rows = [
    budget('food', '2026-06-01', 50_000),
    budget('food', '2026-09-01', 60_000),
    budget('food', '2026-11-01', null),
    budget('food', '2026-08-01', 1, { deleted_at: AT }),
    budget('eat', '2026-01-01', 20_000),
  ];

  it('is the newest row starting by the month, so a change leaves earlier months alone', () => {
    expect(budgetFor('food', '2026-05', rows)).toBeNull();
    expect(budgetFor('food', '2026-07', rows)?.amountMinor).toBe(50_000);
    expect(budgetFor('food', '2026-08', rows)?.amountMinor).toBe(50_000);
    expect(budgetFor('food', '2026-10', rows)?.amountMinor).toBe(60_000);
  });

  it('is none from a row that says none', () => {
    expect(budgetFor('food', '2026-12', rows)).toBeNull();
  });

  it('finds the row a change from a month edits', () => {
    expect(budgetRowIn('food', '2026-09', rows)?.amount_minor).toBe(60_000);
    expect(budgetRowIn('food', '2026-10', rows)).toBeNull();
    expect(budgetRowIn('food', '2026-08', rows)).toBeNull();
  });

  it('is shared as tenths of a percent', () => {
    expect(spentShare(30_000n, 60_000n)).toBe(500);
    expect(spentShare(90_000n, 60_000n)).toBe(1500);
    expect(spentShare(-5n, 60_000n)).toBe(0);
    expect(spentShare(5n, 0n)).toBeNull();
  });
});

describe('a month', () => {
  const file = makeFiler(
    [food, eating, pay, moves],
    [choice('mine', 'eat')],
    [rule('r', 'aldi', 'food', '2026-09-01')],
    TODAY,
  );
  const rows = [
    txn('wf', '2026-09-02', -12_000, { source_category: 'Groceries' }),
    txn('aldi', '2026-09-05', -3_000, { payee: 'ALDI' }),
    txn('refund', '2026-09-06', 1_000, { source_category: 'Groceries' }),
    txn('mine', '2026-09-07', -4_500, { source_category: 'Groceries' }),
    txn('salary', '2026-09-15', 500_000, { source_category: 'Paychecks' }),
    txn('card-pay', '2026-09-16', 80_000, { source_category: 'Credit Card Payment' }),
    txn('unsorted', '2026-09-20', -700),
    txn('august', '2026-08-31', -99_999, { source_category: 'Groceries' }),
    txn('removed', '2026-09-03', -99_999, { source_category: 'Groceries', deleted_at: AT }),
    txn('broker', '2026-09-03', -99_999, { account_id: 'brokerage' }),
  ];

  it('lists the month’s transactions in counted accounts, newest first, each filed', () => {
    const entries = entriesIn('2026-09', rows, COUNTED, file, TODAY);
    expect(entries.map((e) => e.transaction.id)).toEqual([
      'unsorted',
      'card-pay',
      'salary',
      'mine',
      'refund',
      'aldi',
      'wf',
    ]);
    expect(entries.map((e) => kindOf(e.filed))).toEqual([
      'none',
      'guess:move',
      'guess:pay',
      'chosen:eat',
      'guess:food',
      'rule:food',
      'guess:food',
    ]);
    expect(entries[0]?.currency).toBe('USD');
  });

  it('sums spending net of refunds against each budget, and keeps income and transfers apart', () => {
    const entries = entriesIn('2026-09', rows, COUNTED, file, TODAY);
    const summary = summarise(
      '2026-09',
      entries,
      [food, eating, pay, moves],
      [budget('food', '2026-09-01', 60_000), budget('eat', '2026-09-01', 4_000)],
      [],
      TODAY,
    );
    expect(summary.ratesOn).toBe(TODAY);
    expect(
      summary.spend.map((line) => [
        line.category.id,
        line.count,
        line.spent.kind === 'summed' ? line.spent.minor : null,
        line.budgetMinor,
      ]),
    ).toEqual([
      ['food', 3, 14_000n, 60_000n],
      ['eat', 1, 4_500n, 4_000n],
    ]);
    expect(summary.spentMinor).toBe(18_500n);
    expect(summary.budgetedMinor).toBe(64_000n);
    expect(summary.incomeMinor).toBe(500_000n);
    expect(summary.income.map((line) => line.category.id)).toEqual(['pay']);
    expect(summary.transfers.map((line) => [line.category.id, line.count])).toEqual([['move', 1]]);
    expect(summary.unsorted).toEqual({ count: 1, net: { kind: 'summed', minor: -700n } });
    expect(summary.conversions).toEqual([]);
  });

  it('lists a budgeted category with nothing spent, and leaves an idle unbudgeted one out', () => {
    const summary = summarise(
      '2026-09',
      [],
      [food, eating, pay],
      [budget('food', '2026-01-01', 60_000)],
      [],
      TODAY,
    );
    expect(summary.spend.map((line) => line.category.id)).toEqual(['food']);
    expect(summary.spend[0]?.spent).toEqual({ kind: 'summed', minor: 0n });
    expect(summary.income).toEqual([]);
    expect(summary.unsorted.count).toBe(0);
    expect(summary.budgetedMinor).toBe(60_000n);
    expect(summary.incomeMinor).toBe(0n);
  });

  it('orders equal spending by name', () => {
    const a = category('a', 'Books');
    const b = category('b', 'Art');
    const summary = summarise(
      '2026-09',
      [],
      [a, b],
      [budget('a', '2026-09-01', 1), budget('b', '2026-09-01', 1)],
      [],
      TODAY,
    );
    expect(summary.spend.map((line) => line.category.name)).toEqual(['Art', 'Books']);
  });

  it('converts euros at the rate the month’s last day had, once per currency', () => {
    const counted = new Map([
      ['card', 'USD'],
      ['castellana', 'EUR'],
    ]);
    const euroRows = [
      txn('e1', '2026-08-03', -1_000, { account_id: 'castellana', source_category: 'Groceries' }),
      txn('e2', '2026-08-20', -1_000, { account_id: 'castellana', source_category: 'Groceries' }),
      txn('u1', '2026-08-21', -500, { source_category: 'Groceries' }),
    ];
    const rates = [rate('2026-08-01', '1.1'), rate('2026-08-29', '1.2'), rate('2026-09-10', '9')];
    const entries = entriesIn(
      '2026-08',
      euroRows,
      counted,
      makeFiler([food], [], [], TODAY),
      TODAY,
    );
    const summary = summarise(
      '2026-08',
      entries,
      [food],
      [budget('food', '2026-08-01', 10_000, { currency: 'EUR' })],
      rates,
      TODAY,
    );
    expect(summary.ratesOn).toBe('2026-08-31');
    const [line] = summary.spend;
    // 20.00 EUR at 1.2 is 24.00 USD, and 5.00 USD besides.
    expect(line?.spent).toEqual({ kind: 'summed', minor: 2_900n });
    expect(line?.budgetMinor).toBe(12_000n);
    expect(summary.conversions.map((c) => c.rate.rate_date)).toEqual(['2026-08-29']);
  });

  it('leaves a sum unsaid rather than short when a currency has no rate', () => {
    const counted = new Map([['castellana', 'EUR']]);
    const euroRows = [
      txn('e1', '2026-09-03', -1_000, { account_id: 'castellana', source_category: 'Groceries' }),
      txn('e2', '2026-09-04', 5_000, { account_id: 'castellana', source_category: 'Paychecks' }),
      txn('e3', '2026-09-05', -1, { account_id: 'castellana' }),
    ];
    const entries = entriesIn(
      '2026-09',
      euroRows,
      counted,
      makeFiler([food, pay], [], [], TODAY),
      TODAY,
    );
    const summary = summarise(
      '2026-09',
      entries,
      [food, pay],
      [budget('food', '2026-09-01', 1_000, { currency: 'EUR' })],
      [],
      TODAY,
    );
    expect(summary.spend[0]?.spent).toEqual({ kind: 'unrated', missing: ['EUR'] });
    expect(summary.spend[0]?.budgetMinor).toBeNull();
    expect(summary.spentMinor).toBeNull();
    expect(summary.budgetedMinor).toBeNull();
    expect(summary.incomeMinor).toBeNull();
    expect(summary.unsorted.net.kind).toBe('unrated');
  });

  it('leaves out a removed category’s line', () => {
    const entries = entriesIn('2026-09', rows, COUNTED, file, TODAY);
    const summary = summarise(
      '2026-09',
      entries,
      [{ ...food, deleted_at: AT }, eating],
      [],
      [],
      TODAY,
    );
    expect(summary.spend.map((line) => line.category.id)).toEqual(['eat']);
  });
});
