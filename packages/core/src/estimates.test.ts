import { describe, expect, it } from 'vitest';

import type { Estimable } from './estimates.ts';
import {
  centsOf,
  due,
  ESTIMATE_EVERY_DAYS,
  fromMarketcheck,
  fromRentcast,
  lastEstimated,
  lookupOf,
  marketcheckSchema,
  rentcastSchema,
} from './estimates.ts';

function estimable(overrides: Partial<Estimable> = {}): Estimable {
  return {
    id: 'a',
    kind: 'home',
    currency: 'USD',
    address: null,
    postal_code: null,
    vin: null,
    odometer_miles: null,
    odometer_on: null,
    deleted_at: null,
    ...overrides,
  };
}

describe('what is asked', () => {
  it('asks RentCast about a home with an address', () => {
    expect(lookupOf(estimable({ address: '1 Main St, Springfield, IL, 62701' }))).toEqual({
      provider: 'rentcast',
      assetId: 'a',
      address: '1 Main St, Springfield, IL, 62701',
    });
  });

  it('asks MarketCheck about a car with its VIN, ZIP code and mileage as she read it', () => {
    const car = estimable({
      kind: 'vehicle',
      vin: '2HGFE1F50PH000001',
      postal_code: '62704',
      odometer_miles: 21_000,
      odometer_on: '2026-01-01',
    });
    expect(lookupOf(car)).toEqual({
      provider: 'marketcheck',
      assetId: 'a',
      vin: '2HGFE1F50PH000001',
      postalCode: '62704',
      miles: 21_000,
    });
  });

  it('asks about nothing it lacks an input for, nothing removed and nothing outside the US', () => {
    expect(lookupOf(estimable())).toBeNull();
    expect(lookupOf(estimable({ kind: 'vehicle', vin: '2HGFE1F50PH000001' }))).toBeNull();
    expect(lookupOf(estimable({ kind: 'valuables' }))).toBeNull();
    expect(lookupOf(estimable({ address: 'x', deleted_at: '2026-09-01T00:00:00Z' }))).toBeNull();
    expect(lookupOf(estimable({ address: 'Calle Mayor 1', currency: 'EUR' }))).toBeNull();
  });

  it('asks again only once the last estimate is a week old', () => {
    expect(due(null, '2026-09-25')).toBe(true);
    expect(due('2026-09-19', '2026-09-25')).toBe(false);
    expect(due('2026-09-18', '2026-09-25')).toBe(true);
    expect(ESTIMATE_EVERY_DAYS).toBe(7);
  });

  it('finds the newest day each asset was estimated by one provider', () => {
    const last = lastEstimated(
      [
        { asset_id: 'a', provider: 'rentcast', valued_on: '2026-09-01' },
        { asset_id: 'a', provider: 'rentcast', valued_on: '2026-09-08' },
        { asset_id: 'a', provider: 'rentcast', valued_on: '2026-09-02' },
        { asset_id: 'b', provider: 'marketcheck', valued_on: '2026-09-20' },
        { asset_id: 'c', provider: null, valued_on: '2026-09-20' },
      ],
      'rentcast',
    );
    expect([...last]).toEqual([['a', '2026-09-08']]);
  });
});

describe('the answers', () => {
  it('keeps RentCast’s price and the range around it, in cents', () => {
    const answer = rentcastSchema.parse({
      price: 527_400,
      priceRangeLow: 480_000.5,
      priceRangeHigh: 620_000,
      comparables: [],
    });
    expect(fromRentcast(answer, 'a', '2026-09-25')).toEqual({
      asset_id: 'a',
      valued_on: '2026-09-25',
      amount_minor: 52_740_000,
      source: 'estimate',
      provider: 'rentcast',
      low_minor: 48_000_050,
      high_minor: 62_000_000,
    });
  });

  it('drops a range that does not hold the price, or is half there', () => {
    const outside = rentcastSchema.parse({ price: 100, priceRangeLow: 200, priceRangeHigh: 300 });
    expect(fromRentcast(outside, 'a', '2026-09-25')?.low_minor).toBeNull();
    const half = rentcastSchema.parse({ price: 100, priceRangeLow: 50 });
    expect(fromRentcast(half, 'a', '2026-09-25')?.high_minor).toBeNull();
  });

  it('refuses an answer with no price', () => {
    expect(rentcastSchema.safeParse({ priceRangeLow: 1 }).success).toBe(false);
    expect(rentcastSchema.safeParse({ price: 0 }).success).toBe(false);
  });

  it('keeps MarketCheck’s price with no range, and nothing when it could not price the VIN', () => {
    const priced = marketcheckSchema.parse({ marketcheck_price: 27_450, msrp: 34_000 });
    expect(fromMarketcheck(priced, 'car', '2026-09-25')).toEqual({
      asset_id: 'car',
      valued_on: '2026-09-25',
      amount_minor: 2_745_000,
      source: 'estimate',
      provider: 'marketcheck',
      low_minor: null,
      high_minor: null,
    });
    const unpriced = marketcheckSchema.parse({ marketcheck_price: null, msrp: null });
    expect(fromMarketcheck(unpriced, 'car', '2026-09-25')).toBeNull();
  });

  it('turns dollars to whole cents, and refuses what cannot be one', () => {
    expect(centsOf(0.1 + 0.2)).toBe(30);
    expect(centsOf(19.999)).toBe(2000);
    expect(centsOf(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(centsOf(-1)).toBeNull();
  });
});
