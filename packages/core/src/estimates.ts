import { z } from 'zod';

import { daysBetween } from './terms.ts';

/**
 * Market estimates for the apartment and the car (ACCT-11): who is asked, with what, how
 * often, and what their answers become. The asking is `api/_lib/estimates.ts`; this is the
 * part with opinions.
 *
 * Nora liked that Monarch kept the home and the car at a market value it re-read itself
 * (ACCT-06). Zillow retired its public API and KBB never had one, so the sources are the two
 * that answered for free when looked at on 25 Sep 2026: RentCast's value AVM for a home, 50
 * calls a month free, and MarketCheck's price model for a car, 500 a month. Neither is her
 * figure, and neither replaces one: an estimate is a row of its own (`source = 'estimate'`),
 * and which value counts is `countedValue` in assets.ts.
 */

/**
 * `lbma` and `gemini` are not asked by this file's job: each is a day's price worked out into a
 * value, a metal's by `api/_lib/metals.ts` (ACCT-12) and a coin's by `api/_lib/crypto.ts`
 * (ACCT-21), and stored as an estimate beside these.
 */
export const PROVIDERS = ['rentcast', 'marketcheck', 'lbma', 'gemini'] as const;

export type Provider = (typeof PROVIDERS)[number];

/** How the screen names each: the provider, and what kind of price it is. */
export const PROVIDER_NAMES: Readonly<Record<Provider, string>> = {
  rentcast: 'RentCast',
  marketcheck: 'MarketCheck',
  lbma: 'LBMA',
  gemini: 'Gemini',
};

/**
 * How often each asset is asked again. Monarch re-estimated the apartment on 71 of 618 days,
 * about weekly (counted 25 Sep from its balance file), and MarketCheck retrains its model
 * weekly. Two assets weekly is about nine calls a month, well inside both free allowances,
 * with room for a failed night asked again at the next run.
 */
export const ESTIMATE_EVERY_DAYS = 7;

/** Both answer in dollars, for places in the US. */
export const ESTIMATE_CURRENCY = 'USD';

/** What the job may read of an asset: what it is asked with, and nothing she says it is worth. */
export const estimableSchema = z.object({
  id: z.string(),
  kind: z.enum(['home', 'vehicle', 'valuables', 'crypto']),
  currency: z.string(),
  address: z.string().nullable(),
  postal_code: z.string().nullable(),
  vin: z.string().nullable(),
  odometer_miles: z.int().nonnegative().nullable(),
  odometer_on: z.iso.date().nullable(),
  deleted_at: z.string().nullable(),
});

export type Estimable = z.output<typeof estimableSchema>;

export type Lookup =
  | { readonly provider: 'rentcast'; readonly assetId: string; readonly address: string }
  | {
      readonly provider: 'marketcheck';
      readonly assetId: string;
      readonly vin: string;
      readonly postalCode: string;
      readonly miles: number;
    };

/** What to ask about an asset, or null when it cannot be asked about. */
export function lookupOf(asset: Estimable): Lookup | null {
  if (asset.deleted_at !== null || asset.currency !== ESTIMATE_CURRENCY) return null;
  if (asset.kind === 'home' && asset.address !== null) {
    return { provider: 'rentcast', assetId: asset.id, address: asset.address };
  }
  if (
    asset.kind === 'vehicle' &&
    asset.vin !== null &&
    asset.postal_code !== null &&
    asset.odometer_miles !== null
  ) {
    // The reading as she gave it, not projected forward: a projection needs a rate of driving
    // nobody has measured, and a stale reading shows its age on the asset's page instead.
    return {
      provider: 'marketcheck',
      assetId: asset.id,
      vin: asset.vin,
      postalCode: asset.postal_code,
      miles: asset.odometer_miles,
    };
  }
  return null;
}

/** Whether an asset whose newest estimate was read on `last` is asked again `today`. */
export function due(last: string | null, today: string): boolean {
  return last === null || daysBetween(last, today) >= ESTIMATE_EVERY_DAYS;
}

/** The newest day each asset was estimated by `provider`, from the job's read of its rows. */
export function lastEstimated(
  rows: readonly { asset_id: string; provider: string | null; valued_on: string }[],
  provider: Provider,
): Map<string, string> {
  const last = new Map<string, string>();
  for (const row of rows) {
    if (row.provider !== provider) continue;
    const held = last.get(row.asset_id);
    if (held === undefined || row.valued_on > held) last.set(row.asset_id, row.valued_on);
  }
  return last;
}

/* ─── the answers ───────────────────────────────────────────────────────────────────────── */

/**
 * RentCast's `/avm/value`: `price` with `priceRangeLow` and `priceRangeHigh`, in dollars,
 * among much else (comparables, the subject property) that is not kept.
 */
export const rentcastSchema = z.object({
  price: z.number().positive(),
  priceRangeLow: z.number().nonnegative().nullish(),
  priceRangeHigh: z.number().nonnegative().nullish(),
});

/**
 * MarketCheck's `/predict/car/us/marketcheck_price`: a dealer-retail price, null when it could
 * not decode the VIN. No range.
 */
export const marketcheckSchema = z.object({
  marketcheck_price: z.number().positive().nullable(),
});

/** An estimate as the job stores it. */
export type NewEstimate = {
  readonly asset_id: string;
  readonly valued_on: string;
  readonly amount_minor: number;
  readonly source: 'estimate';
  readonly provider: Provider;
  readonly low_minor: number | null;
  readonly high_minor: number | null;
};

/**
 * Dollars as the providers send them, a JSON number, to cents. The one float in the path, and
 * it stops here: a price below 2^53 cents rounds to the cent it was sent as (invariant 1).
 */
export function centsOf(dollars: number): number | null {
  const cents = Math.round(dollars * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

export function fromRentcast(
  answer: z.output<typeof rentcastSchema>,
  assetId: string,
  today: string,
): NewEstimate | null {
  const amount = centsOf(answer.price);
  if (amount === null) return null;
  const lowDollars = answer.priceRangeLow ?? null;
  const highDollars = answer.priceRangeHigh ?? null;
  const low = lowDollars === null ? null : centsOf(lowDollars);
  const high = highDollars === null ? null : centsOf(highDollars);
  // A range that does not hold the price is not a range around it, and is dropped rather than
  // stored, as `asset_values_range` would refuse the row.
  const ranged = low !== null && high !== null && low <= amount && amount <= high;
  return {
    asset_id: assetId,
    valued_on: today,
    amount_minor: amount,
    source: 'estimate',
    provider: 'rentcast',
    low_minor: ranged ? low : null,
    high_minor: ranged ? high : null,
  };
}

export function fromMarketcheck(
  answer: z.output<typeof marketcheckSchema>,
  assetId: string,
  today: string,
): NewEstimate | null {
  const amount = answer.marketcheck_price === null ? null : centsOf(answer.marketcheck_price);
  if (amount === null) return null;
  return {
    asset_id: assetId,
    valued_on: today,
    amount_minor: amount,
    source: 'estimate',
    provider: 'marketcheck',
    low_minor: null,
    high_minor: null,
  };
}
