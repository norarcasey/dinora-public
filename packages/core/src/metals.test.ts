import { describe, expect, it } from 'vitest';

import type { PriceRow, Valuable } from './metals.ts';
import {
  dayBefore,
  describeFineness,
  formatGrams,
  formatPrice,
  latestPrice,
  lbmaSchema,
  metalWorth,
  milligramsOf,
  pieceOf,
  pieceValueMinor,
  priceNeeds,
  toNewPrices,
  unstored,
  valuesToStore,
} from './metals.ts';

const bracelet = { metal: 'gold', mg: 52_300, fineness: 750 } as const;

function valuable(overrides: Partial<Valuable> = {}): Valuable {
  return {
    id: 'b',
    currency: 'USD',
    acquired_on: '2022-03-01',
    metal: 'gold',
    metal_mg: 52_300,
    fineness: 750,
    deleted_at: null,
    ...overrides,
  };
}

let made = 0;

function price(date: string, value: string, overrides: Partial<PriceRow> = {}): PriceRow {
  made += 1;
  return {
    id: `p${made}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    source: 'lbma',
    metal: 'gold',
    currency: 'USD',
    price_date: date,
    price: value,
    ...overrides,
  };
}

describe('what a piece is worth', () => {
  it('is weight × purity × the price of a troy ounce, to the cent', () => {
    // 52.3 g of 18-karat at $4,266.40 an ounce: 538,041.26 cents, worked out in decimal.
    expect(pieceValueMinor(bracelet, '4266.4', 'USD')).toBe(538_041n);
  });

  it('rounds half up, once, at the end', () => {
    // A troy ounce of pure metal at $1 is 100 cents exactly, whatever the rounding.
    expect(pieceValueMinor({ metal: 'silver', mg: 31_103, fineness: 1000 }, '1', 'USD')).toBe(100n);
    // 1 kg of fine silver at $63.58: 204,210.03 cents.
    expect(pieceValueMinor({ metal: 'silver', mg: 1_000_000, fineness: 999 }, '63.58', 'USD')).toBe(
      204_210n,
    );
  });

  it('prices in the currency the asset is kept in', () => {
    // Ten troy ounces of 24-karat at €3,751.87: 3,748,120.93 cents.
    expect(pieceValueMinor({ metal: 'gold', mg: 311_035, fineness: 999 }, '3751.87', 'EUR')).toBe(
      3_748_121n,
    );
  });

  it('refuses a price that is not decimal text, or a currency it cannot place', () => {
    expect(pieceValueMinor(bracelet, '4.2e3', 'USD')).toBeNull();
    expect(pieceValueMinor(bracelet, '4266.4', 'usd')).toBeNull();
  });

  it('is a piece only when all three are said', () => {
    expect(pieceOf({ metal: 'gold', metal_mg: 52_300, fineness: 750 })).toEqual(bracelet);
    expect(pieceOf({ metal: 'gold', metal_mg: null, fineness: 750 })).toBeNull();
    expect(pieceOf({ metal: null, metal_mg: null, fineness: null })).toBeNull();
  });
});

describe('a weight as she reads it', () => {
  it('reads grams to the milligram', () => {
    expect(milligramsOf('52.3', 'g')).toBe(52_300);
    expect(milligramsOf('1,000', 'g')).toBe(1_000_000);
    expect(milligramsOf('0.0005', 'g')).toBe(1);
  });

  it('reads troy ounces, 31.1034768 g each', () => {
    expect(milligramsOf('1', 'ozt')).toBe(31_103);
    expect(milligramsOf('10', 'ozt')).toBe(311_035);
    expect(milligramsOf('0.5', 'ozt')).toBe(15_552);
  });

  it('refuses nothing, a negative, and more places than a scale shows', () => {
    expect(milligramsOf('', 'g')).toBeNull();
    expect(milligramsOf('0', 'g')).toBeNull();
    expect(milligramsOf('-3', 'g')).toBeNull();
    expect(milligramsOf('1.23456', 'g')).toBeNull();
    expect(milligramsOf('abc', 'ozt')).toBeNull();
  });

  it('writes grams back as a scale shows them', () => {
    expect(formatGrams(52_300, 'en-US')).toBe('52.3 g');
    expect(formatGrams(1_000_000, 'en-US')).toBe('1,000 g');
  });

  it('writes a price with every digit published, and the cents at least', () => {
    expect(formatPrice('4266.4', 'USD', 'en-US')).toBe('$4,266.40');
    expect(formatPrice('65.185', 'USD', 'en-US')).toBe('$65.185');
    expect(formatPrice('1922', 'EUR', 'en-US')).toBe('€1,922.00');
    expect(formatPrice('4.2e3', 'USD', 'en-US')).toBe('4.2e3');
  });

  it('names a purity by its mark where it has one', () => {
    expect(describeFineness('gold', 750)).toBe('18-karat');
    expect(describeFineness('silver', 925)).toBe('Sterling');
    expect(describeFineness('gold', 583)).toBe('583/1000');
  });
});

describe('the LBMA files', () => {
  // The shape of prices.lbma.org.uk/json/gold_pm.json, its first row and two of 25 Sep 2026's.
  const file = lbmaSchema.parse([
    { is_cms_locked: 0, d: '1968-04-01', v: [37.7, 15.68, null] },
    { is_cms_locked: 0, d: '2026-09-23', v: [4284.45, 3229.62, 3757.89] },
    { is_cms_locked: 0, d: '2026-09-24', v: [4266.4, 3227.53, 3751.87] },
  ]);

  it('keeps one currency from a day on, with the digits published', () => {
    expect(toNewPrices(file, 'gold', 'USD', '2026-09-24')).toEqual([
      { source: 'lbma', metal: 'gold', currency: 'USD', price_date: '2026-09-24', price: '4266.4' },
    ]);
    expect(toNewPrices(file, 'gold', 'EUR', '2026-01-01')?.map((p) => p.price)).toEqual([
      '3757.89',
      '3751.87',
    ]);
  });

  it('skips a day with no price in that currency', () => {
    expect(toNewPrices(file, 'gold', 'EUR', '1968-01-01')).toHaveLength(2);
  });

  it('refuses a file with a price that does not read back as decimal text', () => {
    const odd = lbmaSchema.parse([{ d: '2026-09-24', v: [1e-7, null, null] }]);
    expect(toNewPrices(odd, 'gold', 'USD', '2026-01-01')).toBeNull();
  });
});

describe('which prices are kept', () => {
  it('reaches a week before the oldest purchase of each metal, per currency', () => {
    expect(
      priceNeeds(
        [
          valuable({ id: 'a', acquired_on: '2022-03-01' }),
          valuable({ id: 'b', acquired_on: '2020-01-10' }),
          valuable({ id: 'c', metal: 'silver', fineness: 925, acquired_on: null }),
          valuable({ id: 'd', currency: 'EUR', acquired_on: '2025-06-01' }),
        ],
        '2026-09-25',
      ),
    ).toEqual([
      { metal: 'gold', currency: 'EUR', from: '2025-05-25' },
      { metal: 'gold', currency: 'USD', from: '2020-01-03' },
      { metal: 'silver', currency: 'USD', from: '2026-08-26' },
    ]);
  });

  it('asks for nothing with no live metal in a currency the LBMA prices', () => {
    expect(priceNeeds([], '2026-09-25')).toEqual([]);
    expect(
      priceNeeds(
        [
          valuable({ deleted_at: '2026-09-01T00:00:00Z' }),
          valuable({ metal: null, metal_mg: null, fineness: null }),
          valuable({ currency: 'JPY' }),
        ],
        '2026-09-25',
      ),
    ).toEqual([]);
  });

  it('sends only what lies outside the stored run', () => {
    const prices = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'].map((d) => ({
      source: 'lbma' as const,
      metal: 'gold' as const,
      currency: 'USD',
      price_date: d,
      price: '1',
    }));
    expect(unstored(prices, null)).toHaveLength(4);
    expect(
      unstored(prices, { first: '2026-09-21', last: '2026-09-22' }).map((p) => p.price_date),
    ).toEqual(['2026-09-20', '2026-09-23']);
  });

  it('counts back whole days, across a month', () => {
    expect(dayBefore('2022-03-01', 7)).toBe('2022-02-22');
  });
});

describe('which values are stored', () => {
  const newest = new Map([['gold USD', { price_date: '2026-09-24', price: '4266.4' }]]);

  it('values each piece at the newest price, dated by the price', () => {
    expect(valuesToStore([valuable()], newest, new Map())).toEqual([
      {
        asset_id: 'b',
        valued_on: '2026-09-24',
        amount_minor: 538_041,
        source: 'estimate',
        provider: 'lbma',
        low_minor: null,
        high_minor: null,
      },
    ]);
  });

  it('stores nothing twice for one price day', () => {
    expect(valuesToStore([valuable()], newest, new Map([['b', '2026-09-24']]))).toEqual([]);
    expect(valuesToStore([valuable()], newest, new Map([['b', '2026-09-23']]))).toHaveLength(1);
  });

  it('passes over a piece with no price in its currency, removed, or not metal', () => {
    expect(
      valuesToStore(
        [
          valuable({ currency: 'EUR' }),
          valuable({ deleted_at: '2026-09-01T00:00:00Z' }),
          valuable({ metal: null, metal_mg: null, fineness: null }),
        ],
        newest,
        new Map(),
      ),
    ).toEqual([]);
  });
});

describe('what the metal has done', () => {
  const prices = [
    price('2022-02-28', '1900'),
    price('2022-03-01', '1922'),
    price('2026-09-23', '4284.45'),
    price('2026-09-24', '4266.4'),
    price('2026-09-24', '3751.87', { currency: 'EUR' }),
    price('2026-09-25', '9999', { deleted_at: '2026-09-25T10:00:00Z' }),
  ];

  it('finds the newest live price, or the newest on or before a day', () => {
    expect(latestPrice(prices, 'gold', 'USD')?.price).toBe('4266.4');
    expect(latestPrice(prices, 'gold', 'USD', '2022-03-06')?.price).toBe('1922');
    expect(latestPrice(prices, 'gold', 'EUR')?.price).toBe('3751.87');
    expect(latestPrice(prices, 'silver', 'USD')).toBeNull();
  });

  it('prices its metal now and on the day she bought it', () => {
    const worth = metalWorth(
      {
        currency: 'USD',
        acquired_on: '2022-03-01',
        metal: 'gold',
        metal_mg: 52_300,
        fineness: 750,
      },
      prices,
    );
    expect(worth?.now?.minor).toBe(538_041);
    expect(worth?.now?.price.price_date).toBe('2026-09-24');
    // 52.3 g × 0.75 at $1,922: 242,385.93 cents.
    expect(worth?.then?.minor).toBe(242_386);
    expect(worth?.then?.price.price_date).toBe('2022-03-01');
  });

  it('says nothing of then with no purchase day or no price that old', () => {
    const piece = { currency: 'USD', metal: 'gold', metal_mg: 52_300, fineness: 750 } as const;
    expect(metalWorth({ ...piece, acquired_on: null }, prices)?.then).toBeNull();
    expect(metalWorth({ ...piece, acquired_on: '2020-01-01' }, prices)?.then).toBeNull();
    expect(metalWorth({ ...piece, acquired_on: null }, [])?.now).toBeNull();
  });

  it('is nothing for an asset that is not metal', () => {
    expect(
      metalWorth(
        { currency: 'USD', acquired_on: null, metal: null, metal_mg: null, fineness: null },
        prices,
      ),
    ).toBeNull();
  });
});
