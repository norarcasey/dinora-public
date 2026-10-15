import { describe, expect, it } from 'vitest';

import type { CategoryRow, ChoiceRow, Filed, RuleRow, TransactionRow } from './budgets.ts';
import { entriesIn, makeFiler, summarise } from './budgets.ts';
import { PAIR_DAYS, pairTransfers } from './transfers.ts';

const TODAY = '2026-09-25';
const AT = '2026-09-25T09:00:00+00:00';

const CURRENCIES = new Map([
  ['checking', 'USD'],
  ['card', 'USD'],
  ['other-card', 'USD'],
  ['loan', 'USD'],
  ['castellana', 'EUR'],
]);

function txn(
  id: string,
  account: string,
  on: string | null,
  minor: number,
  overrides: Partial<TransactionRow> = {},
): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: account,
    posted_at: on === null ? null : `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee: null,
    description: id,
    source_category: null,
    pending: false,
    ...overrides,
  };
}

function category(
  id: string,
  kind: CategoryRow['kind'],
  overrides: Partial<CategoryRow> = {},
): CategoryRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name: id,
    kind,
    guesses_from: [],
    created_at: AT,
    ...overrides,
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

function rule(payee: string, categoryId: string): RuleRow {
  return {
    id: `r-${payee}`,
    updated_at: AT,
    deleted_at: null,
    payee,
    category_id: categoryId,
    starts_on: '2026-09-01',
    created_at: AT,
  };
}

/** Each transaction's partner, by id, for comparing. */
function partners(transactions: readonly TransactionRow[]): Record<string, string> {
  const pairs = pairTransfers(transactions, CURRENCIES, TODAY);
  return Object.fromEntries([...pairs].map(([id, partner]) => [id, partner.id]));
}

function kindOf(filed: Filed): string {
  return filed.kind === 'none' ? 'none' : `${filed.kind}:${filed.category.id}`;
}

describe('pairing', () => {
  it('pairs a payment out of checking with the same amount onto a card', () => {
    const out = txn('out', 'checking', '2026-09-03', -200_000);
    const into = txn('in', 'card', '2026-09-05', 200_000);
    expect(partners([out, into])).toEqual({ out: 'in', in: 'out' });
  });

  it('pairs a payment to an account the budget does not count', () => {
    expect(
      partners([
        txn('out', 'checking', '2026-09-03', -150_000),
        txn('in', 'loan', '2026-09-03', 150_000),
      ]),
    ).toEqual({ out: 'in', in: 'out' });
  });

  it(`pairs no more than ${PAIR_DAYS} days apart`, () => {
    const out = txn('out', 'checking', '2026-09-03', -5000);
    expect(partners([out, txn('in', 'card', '2026-09-08', 5000)])).toEqual({
      out: 'in',
      in: 'out',
    });
    expect(partners([out, txn('in', 'card', '2026-09-09', 5000)])).toEqual({});
    expect(partners([out, txn('in', 'card', '2026-08-29', 5000)])).toEqual({
      out: 'in',
      in: 'out',
    });
  });

  it('never pairs within one account, one direction, or across currencies', () => {
    expect(
      partners([
        txn('buy', 'card', '2026-09-03', -5000),
        txn('refund', 'card', '2026-09-04', 5000),
      ]),
    ).toEqual({});
    expect(
      partners([txn('a', 'checking', '2026-09-03', -5000), txn('b', 'card', '2026-09-03', -5000)]),
    ).toEqual({});
    expect(
      partners([
        txn('a', 'checking', '2026-09-03', -5000),
        txn('b', 'castellana', '2026-09-03', 5000),
      ]),
    ).toEqual({});
  });

  it('never pairs an amount of nothing, a removed row, or an account it does not know', () => {
    expect(
      partners([txn('a', 'checking', '2026-09-03', 0), txn('b', 'card', '2026-09-03', 0)]),
    ).toEqual({});
    expect(
      partners([
        txn('a', 'checking', '2026-09-03', -5000, { deleted_at: AT }),
        txn('b', 'card', '2026-09-03', 5000),
      ]),
    ).toEqual({});
    expect(
      partners([
        txn('a', 'checking', '2026-09-03', -5000),
        txn('b', 'brokerage', '2026-09-03', 5000),
      ]),
    ).toEqual({});
  });

  it('pairs each side once, the closest days first', () => {
    const pairs = partners([
      txn('aug', 'checking', '2026-08-30', -5000),
      txn('sep', 'checking', '2026-09-03', -5000),
      txn('in', 'card', '2026-09-03', 5000),
    ]);
    expect(pairs).toEqual({ sep: 'in', in: 'sep' });
  });

  it('pairs two monthly payments of one amount each with its own month', () => {
    expect(
      partners([
        txn('aug-out', 'checking', '2026-08-03', -5000),
        txn('aug-in', 'card', '2026-08-05', 5000),
        txn('sep-out', 'checking', '2026-09-03', -5000),
        txn('sep-in', 'card', '2026-09-04', 5000),
      ]),
    ).toEqual({
      'aug-out': 'aug-in',
      'aug-in': 'aug-out',
      'sep-out': 'sep-in',
      'sep-in': 'sep-out',
    });
  });

  it('breaks a tie by the earlier day and then by id, so every device agrees', () => {
    const rows = [
      txn('b', 'checking', '2026-09-03', -5000),
      txn('a', 'other-card', '2026-09-03', -5000),
      txn('in', 'card', '2026-09-03', 5000),
    ];
    expect(partners(rows)).toEqual({ a: 'in', in: 'a' });
    expect(partners([...rows].reverse())).toEqual({ a: 'in', in: 'a' });
    const early = [
      txn('late', 'checking', '2026-09-10', -5000),
      txn('in', 'card', '2026-09-07', 5000),
      txn('early', 'other-card', '2026-09-04', -5000),
    ];
    expect(partners(early)).toEqual({ early: 'in', in: 'early' });
  });

  it('dates a pending, undated side today', () => {
    expect(
      partners([
        txn('out', 'checking', null, -5000, { pending: true }),
        txn('in', 'card', '2026-09-23', 5000),
      ]),
    ).toEqual({ out: 'in', in: 'out' });
  });
});

describe('filing a pair', () => {
  const moves = category('move', 'transfer', { guesses_from: ['Transfer'] });
  const payments = category('payment', 'transfer', {
    guesses_from: ['Credit Card Payment'],
    created_at: '2026-09-25T10:00:00+00:00',
  });
  const shopping = category('shop', 'spend', { guesses_from: ['Shopping'] });
  const out = txn('out', 'checking', '2026-09-03', -200_000, { payee: 'Chase Autopay' });
  const into = txn('in', 'card', '2026-09-04', 200_000, {
    payee: 'Payment Thank You',
    source_category: 'Shopping',
  });
  const pairs = pairTransfers([out, into], CURRENCIES, TODAY);

  it('files both sides as a transfer, before Monarch’s guess', () => {
    const file = makeFiler([moves, shopping], [], [], TODAY, pairs);
    expect(kindOf(file(out))).toBe('paired:move');
    expect(kindOf(file(into))).toBe('paired:move');
    const filed = file(into);
    expect(filed.kind === 'paired' && filed.partner.id).toBe('out');
  });

  it('files the pair where either side’s guess is a transfer category', () => {
    const guessed = { ...out, source_category: 'Credit Card Payment' };
    const file = makeFiler(
      [moves, payments, shopping],
      [],
      [],
      TODAY,
      pairTransfers([guessed, into], CURRENCIES, TODAY),
    );
    expect(kindOf(file(guessed))).toBe('paired:payment');
    expect(kindOf(file(into))).toBe('paired:payment');
  });

  it('follows her transfer choice or rule on the other side', () => {
    const chosen = makeFiler([moves, payments], [choice('out', 'payment')], [], TODAY, pairs);
    expect(kindOf(chosen(out))).toBe('chosen:payment');
    expect(kindOf(chosen(into))).toBe('paired:payment');
    const ruled = makeFiler(
      [moves, payments],
      [],
      [rule('chase autopay', 'payment')],
      TODAY,
      pairs,
    );
    expect(kindOf(ruled(out))).toBe('rule:payment');
    expect(kindOf(ruled(into))).toBe('paired:payment');
  });

  it('unpairs both when she files either side as something other than a transfer', () => {
    const file = makeFiler([moves, shopping], [choice('out', 'shop')], [], TODAY, pairs);
    expect(kindOf(file(out))).toBe('chosen:shop');
    expect(kindOf(file(into))).toBe('guess:shop');
    const ruled = makeFiler([moves, shopping], [], [rule('chase autopay', 'shop')], TODAY, pairs);
    expect(kindOf(ruled(into))).toBe('guess:shop');
  });

  it('leaves the pair unfiled with no transfer category to file it in', () => {
    const file = makeFiler([shopping, { ...moves, deleted_at: AT }], [], [], TODAY, pairs);
    expect(kindOf(file(out))).toBe('none');
    expect(kindOf(file(into))).toBe('guess:shop');
  });

  it('keeps a paid card out of the month’s spending', () => {
    const buy = txn('buy', 'card', '2026-09-01', -200_000, { source_category: 'Shopping' });
    const rows = [buy, out, into];
    const counted = new Map([
      ['checking', 'USD'],
      ['card', 'USD'],
    ]);
    const file = makeFiler(
      [moves, shopping],
      [],
      [],
      TODAY,
      pairTransfers(rows, CURRENCIES, TODAY),
    );
    const entries = entriesIn('2026-09', rows, counted, file, TODAY);
    const summary = summarise('2026-09', entries, [moves, shopping], [], [], TODAY);
    expect(summary.spentMinor).toBe(200_000n);
    expect(summary.transfers.map((line) => [line.category.id, line.count, line.net])).toEqual([
      ['move', 2, { kind: 'summed', minor: 0n }],
    ]);
  });
});
