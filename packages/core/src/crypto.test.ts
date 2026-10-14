import { describe, expect, it } from 'vitest';

import type { CryptoPriceRow, Holding } from './crypto.ts';
import {
  candlesSchema,
  closeOf,
  coinOf,
  compareCryptoPrices,
  formatQuantity,
  holdingValueMinor,
  holdingValuesToStore,
  holdingWorth,
  priceText,
  quantityOf,
  sameQuantity,
  symbolOf,
  toNewCryptoPrices,
} from './crypto.ts';

const DAY = 86_400_000;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);

function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: 'btc',
    currency: 'USD',
    coin: 'BTC',
    coin_quantity: '0.0123',
    deleted_at: null,
    ...overrides,
  };
}

let made = 0;

function close(date: string, value: string, overrides: Partial<CryptoPriceRow> = {}) {
  made += 1;
  return {
    id: `c${made}`,
    updated_at: '2026-09-26T09:00:00+00:00',
    deleted_at: null,
    source: 'gemini',
    coin: 'BTC',
    currency: 'USD',
    price_date: date,
    price: value,
    ...overrides,
  } satisfies CryptoPriceRow;
}

describe('a coin as she types it', () => {
  it('is Gemini’s upper-case name', () => {
    expect(coinOf(' btc ')).toBe('BTC');
    expect(coinOf('Shib')).toBe('SHIB');
    expect(coinOf('2z')).toBe('2Z');
  });

  it('is refused when it cannot be a coin', () => {
    for (const text of ['', ' ', 'BT C', 'BTC/USD', '₿', 'A'.repeat(16)]) {
      expect(coinOf(text)).toBeNull();
    }
  });

  it('is asked for against the dollar', () => {
    expect(symbolOf('BTC')).toBe('btcusd');
  });
});

describe('a quantity as she types it', () => {
  it('is kept as the shortest decimal text, every digit she typed', () => {
    expect(quantityOf('0.01230000')).toBe('0.0123');
    expect(quantityOf('  1.5 ')).toBe('1.5');
    expect(quantityOf('007')).toBe('7');
    expect(quantityOf('.5')).toBe('0.5');
    expect(quantityOf('10.000')).toBe('10');
    expect(quantityOf('0.000000000000000001')).toBe('0.000000000000000001');
  });

  it('reads commas and spaces between digits as grouping', () => {
    expect(quantityOf('12,500,000')).toBe('12500000');
    expect(quantityOf('12 500 000.25')).toBe('12500000.25');
  });

  it('is refused rather than rounded past eighteen places', () => {
    expect(quantityOf('0.0000000000000000001')).toBeNull();
  });

  it('is refused at nothing, below nothing, or past a hundred quintillion', () => {
    for (const text of ['', '0', '0.000', '-1', '1e5', 'abc', '1.', '1,', ',1', '1..2']) {
      expect(quantityOf(text)).toBeNull();
    }
    expect(quantityOf('99999999999999999999')).toBe('99999999999999999999');
    expect(quantityOf('100000000000000000000')).toBeNull();
  });

  it('compares as a number, not as text', () => {
    expect(sameQuantity('1.50', '1.5')).toBe(true);
    expect(sameQuantity('0.0123', '0.01230')).toBe(true);
    expect(sameQuantity('0.0123', '0.0124')).toBe(false);
    expect(sameQuantity('x', 'x')).toBe(true);
    expect(sameQuantity('x', '1')).toBe(false);
  });

  it('is shown with every digit, grouped', () => {
    expect(formatQuantity('12500000', 'SHIB', 'en-US')).toBe('12,500,000 SHIB');
    expect(formatQuantity('0.000000000000000001', 'ETH', 'en-US')).toBe('0.000000000000000001 ETH');
    expect(formatQuantity('odd', 'BTC', 'en-US')).toBe('odd BTC');
  });
});

describe('what a holding is worth', () => {
  it('is quantity × close, to the cent', () => {
    // 0.0123 × 84,098 is 1,034.4054 dollars.
    expect(holdingValueMinor('0.0123', '84098', 'USD')).toBe(103_441n);
    // 12,500,000 × 0.000005959 is 74.4875 dollars: half a cent, rounded up.
    expect(holdingValueMinor('12500000', '0.000005959', 'USD')).toBe(7_449n);
  });

  it('rounds half up, once, at the end', () => {
    expect(holdingValueMinor('0.5', '0.01', 'USD')).toBe(1n);
    expect(holdingValueMinor('0.4', '0.01', 'USD')).toBe(0n);
    expect(holdingValueMinor('1', '1', 'USD')).toBe(100n);
  });

  it('keeps what floats would lose', () => {
    // 0.1 × 3 in floats is 0.30000000000000004; ten million times it is not a cent off here.
    expect(holdingValueMinor('10000000.1', '3', 'USD')).toBe(3_000_000_030n);
    expect(holdingValueMinor('99999999999999999999', '84098', 'USD')).toBe(
      840_979_999_999_999_999_991_590_200n,
    );
  });

  it('uses the currency’s own minor unit', () => {
    expect(holdingValueMinor('1.5', '3', 'JPY')).toBe(5n);
  });

  it('is nothing for text that is not a decimal or a currency it cannot place', () => {
    expect(holdingValueMinor('1e3', '1', 'USD')).toBeNull();
    expect(holdingValueMinor('1', '-1', 'USD')).toBeNull();
    expect(holdingValueMinor('1', '1', 'usd')).toBeNull();
  });
});

describe('a close as text', () => {
  it('is the digits Gemini sent', () => {
    expect(priceText(84098)).toBe('84098');
    expect(priceText(84384.61)).toBe('84384.61');
    expect(priceText(0.000005959)).toBe('0.000005959');
  });

  it('expands an exponent rather than refusing a coin priced below a millionth', () => {
    expect(priceText(9e-7)).toBe('0.0000009');
    expect(priceText(1.234e-9)).toBe('0.000000001234');
  });

  it('is nothing for no price at all', () => {
    for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(priceText(n)).toBeNull();
    }
  });
});

describe('Gemini’s candles', () => {
  const candles = candlesSchema.parse([
    [at('2026-09-26'), 84098, 84500, 83000, 84200, 12.5],
    [at('2026-09-25'), 84384.61, 85231.07, 83182.95, 84098, 133.32449757],
    [at('2026-09-24'), 84385.1, 84899.74, 82858.23, 84384.61, 172.96784467],
    [at('2026-08-01'), 1, 1, 1, 60000, 1],
  ]);

  it('are completed UTC days, oldest first, from a day on', () => {
    expect(toNewCryptoPrices(candles, 'BTC', '2026-08-27', '2026-09-26')).toEqual([
      {
        source: 'gemini',
        coin: 'BTC',
        currency: 'USD',
        price_date: '2026-09-24',
        price: '84384.61',
      },
      { source: 'gemini', coin: 'BTC', currency: 'USD', price_date: '2026-09-25', price: '84098' },
    ]);
  });

  it('leave out the day still running, even if it is listed', () => {
    const prices = toNewCryptoPrices(candles, 'BTC', '2026-09-01', '2026-09-26') ?? [];
    expect(prices.map((p) => p.price_date)).not.toContain('2026-09-26');
  });

  it('are refused whole when a candle does not start a UTC day', () => {
    const shifted = candlesSchema.parse([[at('2026-09-25') + DAY / 2, 1, 1, 1, 1, 1]]);
    expect(toNewCryptoPrices(shifted, 'BTC', '2026-09-01', '2026-09-26')).toBeNull();
    const negative = candlesSchema.parse([[-DAY, 1, 1, 1, 1, 1]]);
    expect(toNewCryptoPrices(negative, 'BTC', '1960-01-01', '2026-09-26')).toBeNull();
  });

  it('are refused whole when a close is not a price', () => {
    const zero = candlesSchema.parse([[at('2026-09-25'), 1, 1, 1, 0, 1]]);
    expect(toNewCryptoPrices(zero, 'BTC', '2026-09-01', '2026-09-26')).toBeNull();
  });

  it('are a shape: five numbers at least', () => {
    expect(candlesSchema.safeParse([[1, 2, 3, 4]]).success).toBe(false);
    expect(candlesSchema.safeParse([[1, 2, 3, 4, '5', 6]]).success).toBe(false);
  });
});

describe('the values the job stores', () => {
  const newest = new Map([['BTC', { price_date: '2026-09-25', price: '84098' }]]);

  it('are one per holding at its coin’s newest close, with the quantity counted', () => {
    expect(holdingValuesToStore([holding()], newest, new Map())).toEqual([
      {
        asset_id: 'btc',
        valued_on: '2026-09-25',
        amount_minor: 103_441,
        source: 'estimate',
        provider: 'gemini',
        low_minor: null,
        high_minor: null,
        coin_quantity: '0.0123',
      },
    ]);
  });

  it('are not written twice for a day, nor for a day already past', () => {
    expect(holdingValuesToStore([holding()], newest, new Map([['btc', '2026-09-25']]))).toEqual([]);
    expect(
      holdingValuesToStore([holding()], newest, new Map([['btc', '2026-09-24']])),
    ).toHaveLength(1);
  });

  it('skip a removed holding, one not in dollars, a coin with no close, and a value too big', () => {
    expect(
      holdingValuesToStore(
        [
          holding({ id: 'gone', deleted_at: '2026-09-25T00:00:00Z' }),
          holding({ id: 'euro', currency: 'EUR' }),
          holding({ id: 'doge', coin: 'DOGE' }),
          holding({ id: 'huge', coin_quantity: '99999999999999999999' }),
        ],
        newest,
        new Map(),
      ),
    ).toEqual([]);
  });
});

describe('the stored closes, as the page reads them', () => {
  const rows = [
    close('2026-09-24', '84384.61'),
    close('2026-09-25', '84098'),
    close('2026-09-26', '1', { deleted_at: '2026-09-27T00:00:00Z' }),
    close('2026-09-26', '0.000005959', { coin: 'SHIB' }),
  ];

  it('are newest first', () => {
    const sorted = rows.toSorted(compareCryptoPrices);
    expect(sorted.map((r) => r.price_date)).toEqual([
      '2026-09-26',
      '2026-09-26',
      '2026-09-25',
      '2026-09-24',
    ]);
  });

  it('give a coin’s newest live close, or its close on a day', () => {
    expect(closeOf(rows, 'BTC', 'USD')?.price).toBe('84098');
    expect(closeOf(rows, 'BTC', 'USD', '2026-09-24')?.price).toBe('84384.61');
    expect(closeOf(rows, 'BTC', 'USD', '2026-09-23')).toBeNull();
    expect(closeOf(rows, 'BTC', 'EUR')).toBeNull();
  });

  it('value the quantity as it stands at the newest close', () => {
    expect(
      holdingWorth({ currency: 'USD', coin: 'BTC', coin_quantity: '0.0123' }, rows),
    ).toMatchObject({ coin: 'BTC', quantity: '0.0123', now: { minor: 103_441 } });
  });

  it('say so before the first close is read', () => {
    expect(holdingWorth({ currency: 'USD', coin: 'ETH', coin_quantity: '1' }, rows)).toEqual({
      coin: 'ETH',
      quantity: '1',
      now: null,
    });
  });

  it('value nothing that is not a holding, or too big to count', () => {
    expect(holdingWorth({ currency: 'USD', coin: null, coin_quantity: null }, rows)).toBeNull();
    expect(
      holdingWorth({ currency: 'USD', coin: 'BTC', coin_quantity: '99999999999999999999' }, rows)
        ?.now,
    ).toBeNull();
  });
});
