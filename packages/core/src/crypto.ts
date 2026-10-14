import { z } from 'zod';

import type { NewEstimate } from './estimates.ts';
import { minorDigits } from './money.ts';

/**
 * Crypto at the day's price (ACCT-21): how much of a coin Nora holds, valued at Gemini's close.
 * The reading is `api/_lib/crypto.ts`; this is the part with opinions.
 *
 * Nora, 27 Sep 2026, of the crypto her Gemini card pays as rewards: "I would rather set how
 * much crypto I have and then display how much that amount is worth instead of setting the
 * value all the time". Linking the exchange through Plaid needs a Gemini API key, and Gemini
 * errors whenever she makes one. So she says the coin and the quantity, re-entered now and
 * then as rewards accrue, and the nightly job does the pricing, as it does gold's (ACCT-12).
 *
 * Nothing here is a float but the one JSON number Gemini sends for a close, and that stops at
 * `priceText`. A quantity is decimal text from her typing to the database and back; a value is
 * the two decimals multiplied as integers and rounded once, to the cent.
 */

export const CRYPTO_SOURCE = 'gemini';

/** Gemini's `<coin>usd` close is the one price read, so a holding is in dollars. */
export const CRYPTO_CURRENCY = 'USD';

/** As `assets_coin_shape`: Gemini's base currencies, BTC, SHIB, 2Z. */
const COIN = /^[A-Z0-9]{1,15}$/;

/** What she types for a coin, as Gemini names it, or null. `btc` and ` BTC ` are `BTC`. */
export function coinOf(text: string): string | null {
  const coin = text.trim().toUpperCase();
  return COIN.test(coin) ? coin : null;
}

/** The market Gemini prices a coin against the dollar in: `btcusd`. */
export function symbolOf(coin: string): string {
  return `${coin.toLowerCase()}usd`;
}

/* ─── decimals as integers ──────────────────────────────────────────────────────────────── */

/** A decimal as an integer and how many of its digits are after the point. */
type Scaled = { readonly digits: bigint; readonly places: number };

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function scaled(text: string): Scaled | null {
  const match = DECIMAL.exec(text);
  if (match === null) return null;
  const [, whole = '', fraction = ''] = match;
  return { digits: BigInt(whole + fraction), places: fraction.length };
}

/** The shortest text for a scaled decimal: no leading zeros, no trailing ones after the point. */
function textOf({ digits, places }: Scaled): string {
  const padded = digits.toString().padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places);
  const fraction = padded.slice(padded.length - places).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * ETH's own smallest unit, a wei, is 1e-18, and `assets_coin_quantity_exact` holds a quantity
 * to it. Gemini's order ticks are coarser, 1e-8 for BTC and 1e-6 for ETH, SHIB, PEPE and BONK
 * (its symbol details, 27 Sep 2026), so no balance it shows is refused.
 */
export const QUANTITY_PLACES = 18;

/** Below 1e20, as the table insists: a hundred quintillion of anything is a typo. */
const QUANTITY_WHOLE_DIGITS = 20;

/**
 * What she types for a quantity, as the shortest decimal text for it, or null. Commas and
 * spaces between digits are read as grouping (`12,500,000` SHIB). Refused rather than rounded
 * past eighteen places, as an amount with too many is (`parseAmount`): a quantity silently
 * rounded is one she did not enter.
 */
export function quantityOf(text: string): string | null {
  const bare = text.trim().replace(/(?<=\d)[,\s](?=\d)/g, '');
  const parsed = scaled(bare.startsWith('.') ? `0${bare}` : bare);
  if (parsed === null || parsed.digits === 0n) return null;
  const quantity = textOf(parsed);
  const [whole = '', fraction = ''] = quantity.split('.');
  if (whole.length > QUANTITY_WHOLE_DIGITS || fraction.length > QUANTITY_PLACES) return null;
  return quantity;
}

/**
 * What `quantity` coins are worth in minor units of `currency` at `price` for one: the two
 * decimals multiplied as integers and divided once, rounded half up, as `pieceValueMinor`
 * does. Null for either not being decimal text, or a currency with no known minor unit.
 */
export function holdingValueMinor(
  quantity: string,
  price: string,
  currency: string,
): bigint | null {
  const q = scaled(quantity);
  const p = scaled(price);
  const digits = minorDigits(currency);
  if (q === null || p === null || digits === null) return null;
  const numerator = q.digits * p.digits * 10n ** BigInt(digits);
  const denominator = 10n ** BigInt(q.places + p.places);
  return (numerator + denominator / 2n) / denominator;
}

/**
 * A close as decimal text. Gemini sends it as a JSON number, so it arrives as a float, and
 * `String` gives back the shortest text that reads as that float: Gemini's own digits, since
 * it sends at most a few significant ones (84098; SHIB's 0.000005959, measured 27 Sep 2026).
 * Below a millionth `String` writes an exponent (`9e-7`), which is expanded as text here
 * rather than refused as an ECB rate's is: a memecoin's close is a few millionths already,
 * and its quote increment is 1e-9.
 */
export function priceText(price: number): string | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const text = String(price);
  if (DECIMAL.test(text)) return text;
  const small = /^(\d)(?:\.(\d+))?e-(\d+)$/.exec(text);
  if (small === null) return null;
  const [, lead = '', rest = '', exponent = ''] = small;
  return `0.${'0'.repeat(Number(exponent) - 1)}${lead}${rest}`;
}

/** "0.0123 BTC" or "12,500,000 SHIB": every digit she entered, grouped as her locale groups. */
export function formatQuantity(quantity: string, coin: string, locale: string | undefined): string {
  if (!isNumericText(quantity)) return `${quantity} ${coin}`;
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: QUANTITY_PLACES });
  return `${format.format(quantity)} ${coin}`;
}

function isNumericText(text: string): text is `${number}` {
  return DECIMAL.test(text);
}

/* ─── Gemini's prices ───────────────────────────────────────────────────────────────────── */

/** `/v1/symbols`: every market Gemini lists, lower case (`btcusd`, `btcgusd`, `shibusd`). */
export const symbolsSchema = z.array(z.string());

/**
 * `/v2/candles/<symbol>/1day`: `[ms, open, high, low, close, volume]`, newest first. Measured
 * 27 Sep 2026 at 22:10 UTC on the 26th: 364 candles, the newest stamped 25 Sep 00:00 UTC, and
 * each one's open the close before it, so the stamp is the start of the UTC day the candle
 * covers and its close the price at that day's end. No candle for the day still running was
 * listed.
 */
export const candlesSchema = z.array(
  z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]).rest(z.number()),
);

/** A close as the job stores it: decimal text, so Gemini's digits are the stored ones. */
export type NewCryptoPrice = {
  readonly source: typeof CRYPTO_SOURCE;
  readonly coin: string;
  readonly currency: typeof CRYPTO_CURRENCY;
  readonly price_date: string;
  readonly price: string;
};

const DAY_MS = 86_400_000;

/**
 * The closes of completed days from `from` on, oldest first. A day not before `today` (UTC) is
 * left out even if listed: its close is not yet the day's. A candle that does not start a UTC
 * day, or a close that is not a price, refuses the whole answer, as a rate does in
 * `toNewRates`: a list read wrong is a list of wrong days.
 */
export function toNewCryptoPrices(
  candles: z.output<typeof candlesSchema>,
  coin: string,
  from: string,
  today: string,
): NewCryptoPrice[] | null {
  const prices: NewCryptoPrice[] = [];
  for (const [at, , , , close] of candles) {
    if (!Number.isSafeInteger(at) || at < 0 || at % DAY_MS !== 0) return null;
    const day = new Date(at).toISOString().slice(0, 10);
    const price = priceText(close);
    if (price === null) return null;
    if (day < from || day >= today) continue;
    prices.push({
      source: CRYPTO_SOURCE,
      coin,
      currency: CRYPTO_CURRENCY,
      price_date: day,
      price,
    });
  }
  return prices.toSorted((a, b) => a.price_date.localeCompare(b.price_date));
}

/**
 * How many days of closes the job sends each night. Gemini lists a year, but a value is worked
 * out from the newest only; the days before it are kept so a value reproduces (invariant 3's
 * reason), and so a month of failed nights leaves no hole once one succeeds. Each is sent
 * every night and stored once (`crypto_prices_one_per_day`), which costs nothing to read.
 */
export const CRYPTO_PRICE_DAYS = 30;

/** What the job may read of a holding: the coin and how much, nothing she says it is worth. */
export const holdingSchema = z.object({
  id: z.string(),
  currency: z.string(),
  coin: z.string().regex(COIN),
  // Selected as `coin_quantity::text`: PostgREST sends a bare numeric as a JSON number.
  coin_quantity: z.string().regex(DECIMAL),
  deleted_at: z.string().nullable(),
});

export type Holding = z.output<typeof holdingSchema>;

/** A value as the job stores it: an estimate that names the quantity it counted. */
export type NewHoldingValue = NewEstimate & { readonly coin_quantity: string };

/**
 * One value per holding at its coin's newest close, when that close is newer than the
 * holding's last value. Dated by the close's day, as a metal's value is by the LBMA's. Worked
 * out from the quantity as it stands tonight, and stored with it: a quantity she changes
 * tomorrow changes tomorrow's value and no other.
 */
export function holdingValuesToStore(
  holdings: readonly Holding[],
  newest: ReadonlyMap<string, { readonly price_date: string; readonly price: string }>,
  lastValued: ReadonlyMap<string, string>,
): NewHoldingValue[] {
  const rows: NewHoldingValue[] = [];
  for (const holding of holdings) {
    if (holding.deleted_at !== null || holding.currency !== CRYPTO_CURRENCY) continue;
    const close = newest.get(holding.coin);
    if (close === undefined) continue;
    const last = lastValued.get(holding.id);
    if (last !== undefined && last >= close.price_date) continue;
    const minor = holdingValueMinor(holding.coin_quantity, close.price, holding.currency);
    if (minor === null || minor > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    rows.push({
      asset_id: holding.id,
      valued_on: close.price_date,
      amount_minor: Number(minor),
      source: 'estimate',
      provider: 'gemini',
      low_minor: null,
      high_minor: null,
      coin_quantity: holding.coin_quantity,
    });
  }
  return rows;
}

/* ─── the stored close, as the app reads it ─────────────────────────────────────────────── */

/** Selected as `price::text`, for the reason `rate` is. */
export const cryptoPriceRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  source: z.literal(CRYPTO_SOURCE),
  coin: z.string().regex(COIN),
  currency: z.string().regex(/^[A-Z]{3}$/),
  price_date: z.iso.date(),
  price: z.string().regex(DECIMAL),
});

export type CryptoPriceRow = z.output<typeof cryptoPriceRowSchema>;

/** Newest first. */
export function compareCryptoPrices(a: CryptoPriceRow, b: CryptoPriceRow): number {
  return b.price_date.localeCompare(a.price_date) || a.id.localeCompare(b.id);
}

/** A coin's close on a day, or its newest when no day is given. */
export function closeOf(
  prices: readonly CryptoPriceRow[],
  coin: string,
  currency: string,
  on?: string,
): CryptoPriceRow | null {
  let found: CryptoPriceRow | null = null;
  for (const row of prices) {
    if (row.deleted_at !== null || row.coin !== coin || row.currency !== currency) continue;
    if (on !== undefined && row.price_date !== on) continue;
    if (found === null || row.price_date > found.price_date) found = row;
  }
  return found;
}

export type HoldingWorth = {
  readonly coin: string;
  /** What she holds now, as she last entered it. */
  readonly quantity: string;
  /** That quantity at the newest close, or null before the first close is read. */
  readonly now: { readonly price: CryptoPriceRow; readonly minor: number } | null;
};

/**
 * What a holding is worth at the newest stored close, from the quantity as it stands, so the
 * page can show a quantity she has just changed before the night values it.
 */
export function holdingWorth(
  asset: {
    readonly currency: string;
    readonly coin: string | null;
    readonly coin_quantity: string | null;
  },
  prices: readonly CryptoPriceRow[],
): HoldingWorth | null {
  if (asset.coin === null || asset.coin_quantity === null) return null;
  const close = closeOf(prices, asset.coin, asset.currency);
  const minor =
    close === null ? null : holdingValueMinor(asset.coin_quantity, close.price, asset.currency);
  return {
    coin: asset.coin,
    quantity: asset.coin_quantity,
    now:
      close === null || minor === null || minor > BigInt(Number.MAX_SAFE_INTEGER)
        ? null
        : { price: close, minor: Number(minor) },
  };
}

/** Whether two quantities are the same number, `1.50` and `1.5` alike. */
export function sameQuantity(a: string, b: string): boolean {
  const x = scaled(a);
  const y = scaled(b);
  if (x === null || y === null) return a === b;
  return textOf(x) === textOf(y);
}
