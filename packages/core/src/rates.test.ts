import { describe, expect, it } from 'vitest';

import type { Total } from './balances.ts';
import type { RateRow } from './rates.ts';
import {
  compareRates,
  convertAt,
  convertMinor,
  describeRateDate,
  frankfurterSchema,
  isRateStale,
  latestRate,
  rateAgeDays,
  rateBetween,
  rateRowSchema,
  rateText,
  sumIn,
  toNewRates,
} from './rates.ts';

function rate(overrides: Partial<RateRow> = {}): RateRow {
  return {
    id: 'r1',
    updated_at: '2026-09-24T09:00:00+00:00',
    deleted_at: null,
    source: 'ecb',
    base: 'EUR',
    quote: 'USD',
    rate_date: '2026-09-18',
    rate: '1.146',
    ...overrides,
  };
}

function total(currency: string, minor: bigint, accounts = 1): Total {
  return { currency, minor, accounts };
}

describe("Frankfurter's answer", () => {
  it('becomes rows carrying the digits the ECB published', () => {
    // As fetched on 24 Sep 2026 with providers=ECB.
    const raw = frankfurterSchema.parse(
      JSON.parse(
        '[{"date":"2026-09-18","base":"EUR","quote":"USD","rate":1.146},' +
          '{"date":"2026-09-24","base":"EUR","quote":"USD","rate":1.1367}]',
      ),
    );
    expect(toNewRates(raw)).toEqual({
      ok: true,
      rates: [
        { source: 'ecb', base: 'EUR', quote: 'USD', rate_date: '2026-09-18', rate: '1.146' },
        { source: 'ecb', base: 'EUR', quote: 'USD', rate_date: '2026-09-24', rate: '1.1367' },
      ],
    });
  });

  it('refuses a rate that would not be stored as the digits sent', () => {
    expect(rateText(1e-7)).toBeNull();
    expect(rateText(0)).toBeNull();
    expect(rateText(162.52)).toBe('162.52');
    expect(toNewRates([{ date: '2026-09-18', base: 'EUR', quote: 'USD', rate: 1e-7 }])).toEqual({
      ok: false,
    });
    expect(toNewRates([{ date: '2026-09-18', base: 'EUR', quote: 'EUR', rate: 1 }])).toEqual({
      ok: false,
    });
  });

  it('refuses a shape it does not know', () => {
    expect(frankfurterSchema.safeParse({ rates: { USD: 1.1 } }).success).toBe(false);
    expect(
      frankfurterSchema.safeParse([{ date: '18/09/2026', base: 'EUR', quote: 'USD', rate: 1 }])
        .success,
    ).toBe(false);
  });
});

describe('the stored rate', () => {
  it('parses as PostgREST sends it with rate::text, and not as a float', () => {
    expect(rateRowSchema.parse(rate())).toEqual(rate());
    expect(rateRowSchema.safeParse({ ...rate(), rate: 1.146 }).success).toBe(false);
  });

  it('is the newest live one for the pair', () => {
    const rows = [
      rate({ id: 'old', rate_date: '2026-09-17', rate: '1.1481' }),
      rate({ id: 'new', rate_date: '2026-09-18' }),
      rate({ id: 'gone', rate_date: '2026-09-21', deleted_at: '2026-09-22T00:00:00+00:00' }),
      rate({ id: 'other', rate_date: '2026-09-23', base: 'GBP' }),
    ];
    expect(latestRate(rows, 'EUR', 'USD')?.id).toBe('new');
    expect(latestRate(rows, 'EUR', 'GBP')).toBeNull();
    expect(rows.toSorted(compareRates).map((r) => r.id)).toEqual(['other', 'gone', 'new', 'old']);
    expect(compareRates(rate({ id: 'a' }), rate({ id: 'b' }))).toBeLessThan(0);
  });
});

describe('converting', () => {
  it('is exact where a float would not be', () => {
    // 1,000.00 EUR at 1.1367 is 1,136.70 USD; 0.1 * 3 style drift would show in the cents.
    expect(convertMinor(100_000n, 'EUR', 'USD', '1.1367')).toBe(113_670n);
    expect(convertMinor(1n, 'EUR', 'USD', '1')).toBe(1n);
    expect(convertMinor(0n, 'EUR', 'USD', '1.1367')).toBe(0n);
  });

  it('rounds half away from zero, once', () => {
    // 0.05 EUR at 1.1 is 0.055 USD.
    expect(convertMinor(5n, 'EUR', 'USD', '1.1')).toBe(6n);
    expect(convertMinor(-5n, 'EUR', 'USD', '1.1')).toBe(-6n);
    // 0.04 EUR at 1.1 is 0.044 USD.
    expect(convertMinor(4n, 'EUR', 'USD', '1.1')).toBe(4n);
    expect(convertMinor(-4n, 'EUR', 'USD', '1.1')).toBe(-4n);
  });

  it('moves between currencies whose minor units differ', () => {
    // 1,000 JPY at 0.0067 USD is 6.70 USD; 1.00 USD at 147.25 JPY is 147 JPY.
    expect(convertMinor(1000n, 'JPY', 'USD', '0.0067')).toBe(670n);
    expect(convertMinor(100n, 'USD', 'JPY', '147.25')).toBe(147n);
  });

  it('holds past what a float can count', () => {
    const huge = 2n ** 60n;
    expect(convertMinor(huge, 'EUR', 'USD', '2')).toBe(huge * 2n);
  });

  it('gives no answer for a rate or currency it cannot read', () => {
    expect(convertMinor(1n, 'EUR', 'USD', '1e3')).toBeNull();
    expect(convertMinor(1n, 'EUR', 'USD', '-1.1')).toBeNull();
    expect(convertMinor(1n, 'euro', 'USD', '1.1')).toBeNull();
  });
});

describe('reading a published rate backwards', () => {
  it('divides dollars into euros by the EUR→USD rate, exactly and rounded once', () => {
    // 1,146.00 USD at 1 EUR = 1.146 USD is exactly 1,000.00 EUR.
    expect(convertAt(114_600n, 'USD', 'EUR', rate({ rate: '1.146' }))).toBe(100_000n);
    // 1.00 USD / 1.1367 = 0.87974… EUR, 0.88; and owed the same way round.
    expect(convertAt(100n, 'USD', 'EUR', rate({ rate: '1.1367' }))).toBe(88n);
    expect(convertAt(-100n, 'USD', 'EUR', rate({ rate: '1.1367' }))).toBe(-88n);
  });

  it('rounds half away from zero even when the rate makes the divisor odd', () => {
    // 0.03 USD at 1 EUR = 2 USD is 0.015 EUR: half a cent, up to 0.02, and down to -0.02.
    expect(convertAt(3n, 'USD', 'EUR', rate({ rate: '2' }))).toBe(2n);
    expect(convertAt(-3n, 'USD', 'EUR', rate({ rate: '2' }))).toBe(-2n);
    // 0.05 USD at 1 EUR = 10 USD is 0.005 EUR; at 1 EUR = 3 USD, 0.01666… is 0.02.
    expect(convertAt(5n, 'USD', 'EUR', rate({ rate: '10' }))).toBe(1n);
    expect(convertAt(5n, 'USD', 'EUR', rate({ rate: '3' }))).toBe(2n);
  });

  it('moves between currencies whose minor units differ', () => {
    // 1,000 JPY at 1 USD = 150 JPY is 6.67 USD; 6.67 USD back is 1,001 JPY, rounded.
    const yen = rate({ base: 'USD', quote: 'JPY', rate: '150' });
    expect(convertAt(1_000n, 'JPY', 'USD', yen)).toBe(667n);
    expect(convertAt(667n, 'USD', 'JPY', yen)).toBe(1_001n);
  });

  it('multiplies as published, and answers nothing for a rate between other currencies', () => {
    expect(convertAt(100_000n, 'EUR', 'USD', rate({ rate: '1.146' }))).toBe(114_600n);
    expect(convertAt(100n, 'GBP', 'EUR', rate())).toBeNull();
    expect(convertAt(100n, 'USD', 'EUR', rate({ rate: '0' }))).toBeNull();
    expect(convertAt(100n, 'USD', 'EUR', rate({ rate: '1e3' }))).toBeNull();
  });

  it('finds the newest rate either way round, the published one on a tie', () => {
    const published = rate({ id: 'p', rate_date: '2026-09-18' });
    const backwards = rate({ id: 'b', base: 'USD', quote: 'EUR', rate_date: '2026-09-18' });
    const older = rate({ id: 'o', rate_date: '2026-09-17' });
    expect(rateBetween([older, published], 'USD', 'EUR')).toBe(published);
    expect(rateBetween([older, published], 'USD', 'EUR', '2026-09-17')).toBe(older);
    expect(rateBetween([backwards, published], 'EUR', 'USD')).toBe(published);
    expect(rateBetween([backwards, older], 'EUR', 'USD')).toBe(backwards);
    expect(rateBetween([older], 'EUR', 'USD', '2026-09-16')).toBeNull();
  });
});

describe('summing in one currency', () => {
  it('sums nothing to zero and one dollar total to itself, with nothing converted', () => {
    expect(sumIn([], [])).toEqual({
      kind: 'summed',
      currency: 'USD',
      minor: 0n,
      accounts: 0,
      conversions: [],
    });
    expect(sumIn([total('USD', -5_000n, 3)], [])).toEqual({
      kind: 'summed',
      currency: 'USD',
      minor: -5_000n,
      accounts: 3,
      conversions: [],
    });
  });

  it('converts each other currency once, at its newest rate, and says which', () => {
    const newest = rate({ id: 'new', rate_date: '2026-09-18', rate: '1.146' });
    const sum = sumIn(
      [total('EUR', 250_000n, 1), total('USD', -120_000n, 3)],
      [rate({ id: 'old', rate_date: '2026-09-17', rate: '1.1481' }), newest],
    );
    expect(sum).toEqual({
      kind: 'summed',
      currency: 'USD',
      // 2,500.00 EUR at 1.146 is 2,865.00 USD, less 1,200.00 owed on the cards.
      minor: 166_500n,
      accounts: 4,
      conversions: [{ currency: 'EUR', minor: 250_000n, converted: 286_500n, rate: newest }],
    });
  });

  it('converts a euro-only total too: the net is always in dollars', () => {
    const sum = sumIn([total('EUR', 100_000n)], [rate({ rate: '1.146' })]);
    expect(sum.kind === 'summed' && sum.minor).toBe(114_600n);
  });

  it('uses the rate a past day had, not a later one', () => {
    const rates = [
      rate({ id: 'a', rate_date: '2026-09-17', rate: '1.1481' }),
      rate({ id: 'b', rate_date: '2026-09-18', rate: '1.146' }),
    ];
    const sum = sumIn([total('EUR', 100_000n)], rates, 'USD', '2026-09-17');
    expect(sum.kind === 'summed' && sum.minor).toBe(114_810n);
    expect(sumIn([total('EUR', 1n)], rates, 'USD', '2026-09-16')).toEqual({
      kind: 'unrated',
      missing: ['EUR'],
    });
  });

  it('converts into another currency when asked', () => {
    const sum = sumIn(
      [total('EUR', 100n), total('USD', 100n)],
      [rate({ base: 'USD', quote: 'EUR', rate: '0.8' })],
      'EUR',
    );
    expect(sum.kind === 'summed' && sum.minor).toBe(180n);
  });

  it('sums in euros from the one rate the ECB publishes, and names that rate', () => {
    const published = rate({ rate: '1.146' });
    const sum = sumIn([total('EUR', 250_000n, 1), total('USD', -114_600n, 3)], [published], 'EUR');
    expect(sum).toEqual({
      kind: 'summed',
      currency: 'EUR',
      // 1,146.00 USD owed is 1,000.00 EUR owed, from 2,500.00 EUR held.
      minor: 150_000n,
      accounts: 4,
      conversions: [{ currency: 'USD', minor: -114_600n, converted: -100_000n, rate: published }],
    });
  });

  it('says nothing across currencies until every one has a rate', () => {
    expect(sumIn([total('EUR', 1n), total('GBP', 1n), total('USD', 1n)], [rate()])).toEqual({
      kind: 'unrated',
      missing: ['GBP'],
    });
    expect(sumIn([total('EUR', 1n), total('USD', 1n)], [])).toEqual({
      kind: 'unrated',
      missing: ['EUR'],
    });
    expect(sumIn([total('EUR', 1n), total('USD', 1n)], [rate({ rate: 'not a number' })])).toEqual({
      kind: 'unrated',
      missing: ['EUR'],
    });
  });
});

describe('how old a rate is', () => {
  it('counts calendar days in UTC', () => {
    expect(rateAgeDays('2026-09-24', Date.parse('2026-09-24T23:59:00Z'))).toBe(0);
    expect(rateAgeDays('2026-09-18', Date.parse('2026-09-20T12:00:00Z'))).toBe(2);
  });

  it('lets an Easter pass and not a week', () => {
    // Easter 2027: Thursday 25 March's rate is the newest until Tuesday's is read on the 31st.
    expect(isRateStale('2027-03-25', Date.parse('2027-03-31T08:59:00Z'))).toBe(false);
    expect(isRateStale('2027-03-25', Date.parse('2027-04-01T00:00:00Z'))).toBe(true);
  });

  it('names the weekday, which is what says a Sunday total uses Friday', () => {
    expect(describeRateDate('2026-09-18', 'en-GB')).toBe('Friday 18 September');
  });
});
