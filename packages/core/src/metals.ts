import { z } from 'zod';

import type { NewEstimate } from './estimates.ts';
import { minorDigits } from './money.ts';
import { rateText } from './rates.ts';

/**
 * Gold and silver at the day's price (ACCT-12): what a piece of metal is worth by weight,
 * purity and the LBMA's price, and what that metal has done since she bought it. The reading
 * is `api/_lib/metals.ts`; this is the part with opinions.
 *
 * Nora, 25 Sep 2026: "I bought a gold bracelet years ago, and gold has gone up a lot since
 * then". A value she re-enters follows the market only as often as she does; weight × purity ×
 * price follows it by itself. It is a floor for jewelry, whose price includes the work, and
 * the screen says so.
 */

export const METALS = ['gold', 'silver'] as const;

export type Metal = (typeof METALS)[number];

export const METAL_SOURCE = 'lbma';

/**
 * The currencies each LBMA file prices in, in the order of its `v` array (checked against the
 * files on 25 Sep 2026: gold's 24 Sep row is [4266.4, 3227.53, 3751.87]). An asset in any of
 * them can be valued without a rate.
 */
export const LBMA_CURRENCIES = ['USD', 'GBP', 'EUR'] as const;

export type LbmaCurrency = (typeof LBMA_CURRENCIES)[number];

/** Milligrams in a troy ounce, times 10⁴: 31.1034768 g exactly, by definition. */
const TROY_OUNCE_MG_E4 = 311_034_768n;

/**
 * The purities a piece is marked with, in thousandths. 14-karat is stamped 585 in Europe and
 * 583 in the US; 585 is the stamp, and the difference is a third of a percent.
 */
export const FINENESS: Readonly<Record<Metal, readonly { label: string; fineness: number }[]>> = {
  gold: [
    { label: '24-karat', fineness: 999 },
    { label: '22-karat', fineness: 916 },
    { label: '18-karat', fineness: 750 },
    { label: '14-karat', fineness: 585 },
    { label: '10-karat', fineness: 417 },
  ],
  silver: [
    { label: 'Fine', fineness: 999 },
    { label: 'Sterling', fineness: 925 },
    { label: 'Coin', fineness: 900 },
    { label: '800', fineness: 800 },
  ],
};

/** How the screen names a purity: its mark's name where it has one, else the thousandths. */
export function describeFineness(metal: Metal, fineness: number): string {
  const known = FINENESS[metal].find((f) => f.fineness === fineness);
  return known === undefined ? `${fineness}/1000` : known.label;
}

/* ─── what a piece is worth ─────────────────────────────────────────────────────────────── */

export type Piece = {
  readonly metal: Metal;
  readonly mg: number;
  /** Thousandths: 750 is 18-karat. */
  readonly fineness: number;
};

/** The metal of an asset, when she has said all three, which the table insists on together. */
export function pieceOf(asset: {
  readonly metal: Metal | null;
  readonly metal_mg: number | null;
  readonly fineness: number | null;
}): Piece | null {
  if (asset.metal === null || asset.metal_mg === null || asset.fineness === null) return null;
  return { metal: asset.metal, mg: asset.metal_mg, fineness: asset.fineness };
}

/**
 * What the pure metal in a piece is worth in minor units of `currency`, at `price` for a troy
 * ounce. All in bigint, one division at the end, rounded half up, as `convertMinor` does: the
 * price's decimal text is an integer and a power of ten. Null for a price that is not decimal
 * text or a currency with no known minor unit.
 */
export function pieceValueMinor(piece: Piece, price: string, currency: string): bigint | null {
  const digits = minorDigits(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (digits === null || match === null) return null;
  const [, whole = '', fraction = ''] = match;
  const numerator =
    BigInt(piece.mg) *
    BigInt(piece.fineness) *
    BigInt(whole + fraction) *
    10n ** BigInt(digits + 4);
  const denominator = 10n ** BigInt(fraction.length) * 1000n * TROY_OUNCE_MG_E4;
  return (numerator + denominator / 2n) / denominator;
}

/** Grams, or troy ounces, as she reads them off a scale or a coin, to whole milligrams. */
export function milligramsOf(text: string, unit: 'g' | 'ozt'): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,4}))?$/.exec(text.replace(/[,\s]/g, ''));
  if (match === null) return null;
  const [, whole = '', fraction = ''] = match;
  const e4 = BigInt(whole + fraction.padEnd(4, '0'));
  // g × 10⁴ → mg is ÷ 10; ozt × 10⁴ → mg is × 31103.4768, which is ÷ 10⁸ of the constant.
  const [numerator, denominator] = unit === 'g' ? [e4, 10n] : [e4 * TROY_OUNCE_MG_E4, 10n ** 8n];
  const mg = (numerator + denominator / 2n) / denominator;
  return mg > 0n && mg <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(mg) : null;
}

/** "52.3 g": grams to three places, as a jeweller's scale reads, trailing zeros dropped. */
export function formatGrams(mg: number, locale: string | undefined): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(mg / 1000)} g`;
}

function isNumericText(text: string): text is `${number}` {
  return /^\d+(\.\d+)?$/.test(text);
}

/**
 * "$4,266.40" or "$65.185": a price with every digit the LBMA published and at least the
 * currency's own, formatted from its text as `formatMinor` formats, so no float is read.
 */
export function formatPrice(price: string, currency: string, locale: string | undefined): string {
  if (!isNumericText(price)) return price;
  const digits = minorDigits(currency) ?? 2;
  const places = price.split('.')[1]?.length ?? 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, places),
  }).format(price);
}

/* ─── the LBMA's prices ─────────────────────────────────────────────────────────────────── */

/**
 * One LBMA file: every business day, `d`, with `v` the price of a troy ounce in each of
 * `LBMA_CURRENCIES`. Early rows have null for the euro, which did not exist.
 */
export const lbmaSchema = z.array(
  z.object({ d: z.iso.date(), v: z.array(z.number().positive().nullable()) }),
);

/** A price as the job stores it: decimal text, so the LBMA's digits are the stored ones. */
export type NewPrice = {
  readonly source: typeof METAL_SOURCE;
  readonly metal: Metal;
  readonly currency: string;
  readonly price_date: string;
  readonly price: string;
};

/**
 * The prices in one file for `currency` from `from` on, skipping days with none. A price that
 * does not read back as decimal text refuses the whole file, as a rate does in `toNewRates`.
 */
export function toNewPrices(
  raw: z.output<typeof lbmaSchema>,
  metal: Metal,
  currency: LbmaCurrency,
  from: string,
): NewPrice[] | null {
  const column = LBMA_CURRENCIES.indexOf(currency);
  const prices: NewPrice[] = [];
  for (const row of raw) {
    if (row.d < from) continue;
    const value = row.v[column] ?? null;
    if (value === null) continue;
    const price = rateText(value);
    if (price === null) return null;
    prices.push({ source: METAL_SOURCE, metal, currency, price_date: row.d, price });
  }
  return prices;
}

/**
 * How far before a purchase prices are kept: the newest price on or before the day she
 * bought it is the one it is compared with, and the LBMA publishes none on weekends or
 * London's bank holidays. A week covers Christmas to Boxing Day's next business day.
 */
export const PRICES_BEFORE_PURCHASE_DAYS = 7;

/** With no purchase day, enough for the newest price and a few before it. */
export const PRICES_WITHOUT_PURCHASE_DAYS = 30;

export function dayBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** What the job may read of an asset to value its metal: nothing she says it is worth. */
export const valuableSchema = z.object({
  id: z.string(),
  currency: z.string(),
  acquired_on: z.iso.date().nullable(),
  metal: z.enum(METALS).nullable(),
  metal_mg: z.int().positive().nullable(),
  fineness: z.int().min(1).max(1000).nullable(),
  deleted_at: z.string().nullable(),
});

export type Valuable = z.output<typeof valuableSchema>;

/** A metal and currency the job is to keep prices for, and from which day. */
export type PriceNeed = {
  readonly metal: Metal;
  readonly currency: LbmaCurrency;
  readonly from: string;
};

function lbmaCurrency(currency: string): LbmaCurrency | null {
  return LBMA_CURRENCIES.find((c) => c === currency) ?? null;
}

/**
 * Which prices the live pieces need, each from a week before the oldest purchase of that
 * metal in that currency. None at all when she owns no metal: the files are not even asked for.
 */
export function priceNeeds(assets: readonly Valuable[], today: string): PriceNeed[] {
  const from = new Map<string, PriceNeed>();
  for (const asset of assets) {
    const piece = pieceOf(asset);
    const currency = lbmaCurrency(asset.currency);
    if (asset.deleted_at !== null || piece === null || currency === null) continue;
    const start =
      asset.acquired_on === null
        ? dayBefore(today, PRICES_WITHOUT_PURCHASE_DAYS)
        : dayBefore(asset.acquired_on, PRICES_BEFORE_PURCHASE_DAYS);
    const key = `${piece.metal} ${currency}`;
    const held = from.get(key);
    if (held === undefined || start < held.from) {
      from.set(key, { metal: piece.metal, currency, from: start });
    }
  }
  return [...from.values()].sort(
    (a, b) => a.metal.localeCompare(b.metal) || a.currency.localeCompare(b.currency),
  );
}

/**
 * The prices to insert: those outside what is stored already. The job stores each need's
 * days as one unbroken run, so what is stored is known by its first and last day, and only
 * days before the first (an older purchase entered since) or after the last are sent.
 */
export function unstored(
  prices: readonly NewPrice[],
  stored: { readonly first: string; readonly last: string } | null,
): NewPrice[] {
  if (stored === null) return [...prices];
  return prices.filter((p) => p.price_date < stored.first || p.price_date > stored.last);
}

/**
 * One value per piece at the newest price, when there is a price day newer than its last
 * value's. Each value is dated by the price's day, not the night it was worked out: it is
 * that day's price, and a weekend reads as Friday's without a rule here, as a rate does.
 */
export function valuesToStore(
  assets: readonly Valuable[],
  newest: ReadonlyMap<string, { readonly price_date: string; readonly price: string }>,
  lastValued: ReadonlyMap<string, string>,
): NewEstimate[] {
  const rows: NewEstimate[] = [];
  for (const asset of assets) {
    const piece = pieceOf(asset);
    if (asset.deleted_at !== null || piece === null) continue;
    const price = newest.get(`${piece.metal} ${asset.currency}`);
    if (price === undefined) continue;
    const last = lastValued.get(asset.id);
    if (last !== undefined && last >= price.price_date) continue;
    const minor = pieceValueMinor(piece, price.price, asset.currency);
    if (minor === null || minor > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    rows.push({
      asset_id: asset.id,
      valued_on: price.price_date,
      amount_minor: Number(minor),
      source: 'estimate',
      provider: 'lbma',
      low_minor: null,
      high_minor: null,
    });
  }
  return rows;
}

/* ─── the stored price, as the app reads it ─────────────────────────────────────────────── */

/** Selected as `price::text`, for the reason `rate` is. */
export const priceRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  source: z.literal(METAL_SOURCE),
  metal: z.enum(METALS),
  currency: z.string().regex(/^[A-Z]{3}$/),
  price_date: z.iso.date(),
  price: z.string().regex(/^\d+(\.\d+)?$/),
});

export type PriceRow = z.output<typeof priceRowSchema>;

/** Newest first. */
export function comparePrices(a: PriceRow, b: PriceRow): number {
  return b.price_date.localeCompare(a.price_date) || a.id.localeCompare(b.id);
}

/** The newest live price of a metal in a currency, or the newest on or before a day. */
export function latestPrice(
  prices: readonly PriceRow[],
  metal: Metal,
  currency: string,
  onOrBefore?: string,
): PriceRow | null {
  let latest: PriceRow | null = null;
  for (const row of prices) {
    if (row.deleted_at !== null || row.metal !== metal || row.currency !== currency) continue;
    if (onOrBefore !== undefined && row.price_date > onOrBefore) continue;
    if (latest === null || row.price_date > latest.price_date) latest = row;
  }
  return latest;
}

export type Priced = { readonly price: PriceRow; readonly minor: number };

export type MetalWorth = {
  readonly piece: Piece;
  /** Its metal at the newest price, or null before the first price is read. */
  readonly now: Priced | null;
  /**
   * Its metal at the price on the day she bought it: what the metal part of what she paid
   * was worth. Null with no purchase day, or no price that old.
   */
  readonly then: Priced | null;
};

function priced(piece: Piece, price: PriceRow | null, currency: string): Priced | null {
  if (price === null) return null;
  const minor = pieceValueMinor(piece, price.price, currency);
  return minor === null || minor > BigInt(Number.MAX_SAFE_INTEGER)
    ? null
    : { price, minor: Number(minor) };
}

/**
 * What an asset's metal is worth now and was worth when she bought it. Worked out from its
 * weight as it stands and the stored prices, so a weight she corrects corrects both.
 */
export function metalWorth(
  asset: {
    readonly currency: string;
    readonly acquired_on: string | null;
    readonly metal: Metal | null;
    readonly metal_mg: number | null;
    readonly fineness: number | null;
  },
  prices: readonly PriceRow[],
): MetalWorth | null {
  const piece = pieceOf(asset);
  if (piece === null) return null;
  const now = priced(piece, latestPrice(prices, piece.metal, asset.currency), asset.currency);
  const then =
    asset.acquired_on === null
      ? null
      : priced(
          piece,
          latestPrice(prices, piece.metal, asset.currency, asset.acquired_on),
          asset.currency,
        );
  return { piece, now, then };
}
