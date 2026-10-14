import { describe, expect, it } from 'vitest';

import type { Charge, Searchable } from './activity.ts';
import {
  addMonths,
  findRecurring,
  fold,
  matches,
  parseQuery,
  payeeYear,
  search,
  searchText,
} from './activity.ts';
import type { TransactionRow } from './budgets.ts';
import type { RateRow } from './rates.ts';

const AT = '2026-09-25T09:00:00+00:00';
const TODAY = '2026-09-25';

function txn(
  id: string,
  on: string,
  minor: number,
  overrides: Partial<TransactionRow> = {},
): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: 'card',
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee: 'Netflix',
    description: '',
    source_category: null,
    pending: false,
    ...overrides,
  };
}

function item(transaction: TransactionRow, overrides: Partial<Searchable> = {}): Searchable {
  return {
    transaction,
    day: '2026-09-01',
    currency: 'USD',
    accountName: 'Visa Signature',
    categoryName: null,
    ...overrides,
  };
}

function charge(id: string, on: string, minor: number, payee = 'Netflix'): Charge {
  return { transaction: txn(id, on, minor, { payee }), day: on, currency: 'USD' };
}

const EUR_USD: RateRow = {
  id: 'r1',
  updated_at: AT,
  deleted_at: null,
  base: 'EUR',
  quote: 'USD',
  rate: '1.1',
  rate_date: '2026-08-31',
  source: 'ecb',
};

describe('fold', () => {
  it('takes the accents off, the case down and the spaces in', () => {
    expect(fold('  CAFÉ   Núñez ')).toBe('cafe nunez');
  });
});

describe('search', () => {
  const coffee = item(txn('a', '2026-09-01', -450, { payee: 'Blue Bottle Coffee' }), {
    categoryName: 'Eating out',
  });
  const rent = item(txn('b', '2026-09-02', -250_000, { payee: null, description: 'RENT SEPT' }), {
    accountName: 'Checking',
  });
  const refund = item(txn('c', '2026-09-03', 1250, { payee: 'Amazon' }));
  const items = [coffee, rent, refund];
  const texts = items.map((i) => searchText(i));
  const find = (text: string) => search(parseQuery(text), items, texts, 10).shown;

  it('finds every word, anywhere: payee, description, account, category', () => {
    expect(find('coffee')).toEqual([coffee]);
    expect(find('rent checking')).toEqual([rent]);
    expect(find('eating')).toEqual([coffee]);
    expect(find('visa')).toEqual([coffee, refund]);
    expect(find('coffee checking')).toEqual([]);
  });

  it('reads a number as an amount, either sign, as well as text', () => {
    expect(find('4.50')).toEqual([coffee]);
    expect(find('$12.5')).toEqual([refund]);
    expect(find('12,50')).toEqual([refund]);
    expect(find('2500')).toEqual([rent]);
    expect(find('4')).toEqual([coffee]);
    expect(find('4.51')).toEqual([]);
  });

  it('finds nothing for an empty query, and counts past the limit', () => {
    expect(search(parseQuery('  '), items, texts, 10)).toEqual({ shown: [], count: 0 });
    expect(search(parseQuery('visa'), items, texts, 1)).toEqual({ shown: [coffee], count: 2 });
  });

  it('works out the text itself when not given it', () => {
    expect(matches(parseQuery('bottle'), coffee)).toBe(true);
  });
});

describe('payeeYear', () => {
  const currencies = new Map([
    ['card', 'USD'],
    ['ejemplo', 'EUR'],
  ]);

  it('is twelve months to this one, the oldest first, with its total and count', () => {
    const year = payeeYear(
      'netflix',
      [
        txn('a', '2026-09-03', -1599),
        txn('b', '2026-08-03', -1599),
        txn('old', '2025-09-03', -1399),
        txn('other', '2026-09-03', -100, { payee: 'Hulu' }),
        txn('gone', '2026-09-04', -100, { deleted_at: AT }),
        txn('nowhere', '2026-09-04', -100, { account_id: 'closed' }),
      ],
      currencies,
      [],
      TODAY,
    );
    expect(year?.months.map((m) => m.month)).toEqual([
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(year?.months.at(-1)?.net).toEqual({ kind: 'summed', minor: -1599n });
    expect(year?.net).toEqual({ kind: 'summed', minor: -3198n });
    expect(year?.count).toBe(2);
    expect(year?.all.map((a) => a.transaction.id)).toEqual(['a', 'b', 'old']);
    expect(year?.name).toBe('Netflix');
  });

  it('converts at the month’s last rate and names it, or leaves the total unsaid', () => {
    const euros = [txn('e', '2026-08-10', -1000, { account_id: 'ejemplo' })];
    const year = payeeYear('netflix', euros, currencies, [EUR_USD], TODAY);
    expect(year?.net).toEqual({ kind: 'summed', minor: -1100n });
    expect(year?.conversions.map((c) => c.rate.id)).toEqual(['r1']);
    const unrated = payeeYear('netflix', euros, currencies, [], TODAY);
    expect(unrated?.net).toEqual({ kind: 'unrated', missing: ['EUR'] });
  });

  it('is nothing for a payee with no transactions', () => {
    expect(payeeYear('nobody', [txn('a', '2026-09-03', -1)], currencies, [], TODAY)).toBeNull();
  });
});

describe('addMonths', () => {
  it('keeps the day, or the month’s last when it is shorter', () => {
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2025-09-30', 12)).toBe('2026-09-30');
  });
});

describe('findRecurring', () => {
  it('finds a monthly charge and when the next is due', () => {
    const [found, ...rest] = findRecurring(
      [
        charge('a', '2026-06-14', -1599),
        charge('b', '2026-07-15', -1599),
        charge('c', '2026-08-14', -1599),
        charge('d', '2026-09-14', -1799),
      ],
      TODAY,
    );
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      key: 'netflix',
      cadence: 'month',
      amountMinor: -1799,
      perYearMinor: 1799 * 12,
      count: 4,
      last: '2026-09-14',
      next: '2026-10-14',
      late: false,
    });
  });

  it('needs three in a row, and counts only the run that keeps the rhythm', () => {
    expect(
      findRecurring([charge('a', '2026-08-14', -999), charge('b', '2026-09-14', -999)], TODAY),
    ).toEqual([]);
    const [found] = findRecurring(
      [
        charge('x', '2025-01-02', -999),
        charge('a', '2026-07-14', -999),
        charge('b', '2026-08-14', -999),
        charge('c', '2026-09-14', -999),
      ],
      TODAY,
    );
    expect(found?.count).toBe(3);
  });

  it('leaves out money in, an unsteady amount, and a charge that has stopped', () => {
    const months = ['2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10'];
    expect(
      findRecurring(
        months.map((on, i) => charge(`p${i}`, on, 500_000)),
        TODAY,
      ),
    ).toEqual([]);
    expect(
      findRecurring(
        months.map((on, i) => charge(`s${i}`, on, i % 2 === 0 ? -1000 : -5000, 'Shop')),
        TODAY,
      ),
    ).toEqual([]);
    expect(
      findRecurring(
        ['2026-03-10', '2026-04-10', '2026-05-10'].map((on, i) => charge(`o${i}`, on, -999)),
        TODAY,
      ),
    ).toEqual([]);
  });

  it('says a charge is late once its day has passed', () => {
    const [found] = findRecurring(
      ['2026-06-20', '2026-07-20', '2026-08-20'].map((on, i) => charge(`l${i}`, on, -999)),
      TODAY,
    );
    expect(found).toMatchObject({ next: '2026-09-20', late: true });
  });

  it('keeps a pending charge and its posting as one', () => {
    const found = findRecurring(
      [
        charge('a', '2026-07-14', -999),
        charge('b', '2026-08-14', -999),
        charge('c', '2026-09-13', -999),
        charge('d', '2026-09-14', -999),
      ],
      TODAY,
    );
    expect(found.map((f) => [f.count, f.latest.id])).toEqual([[3, 'd']]);
  });

  it('finds weekly and yearly rhythms', () => {
    const weekly = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22'].map((on, i) =>
      charge(`w${i}`, on, -700, 'Gym'),
    );
    const yearly = [
      charge('y1', '2024-10-02', -9900, 'Domain'),
      charge('y2', '2025-10-01', -9900, 'Domain'),
    ];
    const found = findRecurring([...weekly, ...yearly], TODAY);
    expect(found.map((f) => [f.name, f.cadence, f.next])).toEqual([
      ['Gym', 'week', '2026-09-29'],
      ['Domain', 'year', '2026-10-01'],
    ]);
  });

  it('splits a payee billing two amounts on their own rhythms', () => {
    const months = ['2026-06-', '2026-07-', '2026-08-', '2026-09-'];
    const small = months.map((m, i) => charge(`s${i}`, `${m}03`, -299, 'Apple'));
    const large = months.map((m, i) => charge(`l${i}`, `${m}18`, -1099, 'Apple'));
    const found = findRecurring([...small, ...large], TODAY);
    expect(found.map((f) => [f.amountMinor, f.next])).toEqual([
      [-299, '2026-10-03'],
      [-1099, '2026-10-18'],
    ]);
  });

  it('keeps currencies apart, and leaves out a removed charge and a payee with no name', () => {
    const on = ['2026-07-05', '2026-08-05', '2026-09-05'];
    const usd = on.map((d, i) => charge(`u${i}`, d, -999));
    const eur = on.map((d, i) => ({ ...charge(`e${i}`, d, -999), currency: 'EUR' }));
    expect(
      findRecurring([...usd, ...eur], TODAY)
        .map((f) => f.currency)
        .sort(),
    ).toEqual(['EUR', 'USD']);
    const removed = on.map((d, i) => ({
      ...charge(`r${i}`, d, -999),
      transaction: txn(`r${i}`, d, -999, { deleted_at: AT }),
    }));
    expect(findRecurring(removed, TODAY)).toEqual([]);
    const blank = on.map((d, i) => ({
      ...charge(`b${i}`, d, -999),
      transaction: txn(`b${i}`, d, -999, { payee: ' ', description: '' }),
    }));
    expect(findRecurring(blank, TODAY)).toEqual([]);
  });
});
