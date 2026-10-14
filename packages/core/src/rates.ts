import { z } from 'zod';

import type { Total } from './balances.ts';
import { minorDigits } from './money.ts';

/**
 * One total across currencies (ACCT-02): the ECB's reference rates, how a stored rate
 * converts an amount without a float, and which rate a total uses.
 *
 * Every rate is kept with the date the ECB published it for (`fx_rates`, invariant 3), and a
 * total says which one it used. The ECB publishes on TARGET working days only; asked for a
 * Sunday, Frankfurter answers with Friday's rate dated Friday (fetched 24 Sep 2026), so the
 * date shown is always the rate's own and a weekend reads as Friday without a rule here.
 */

export const RATE_SOURCE = 'ecb';

/** Every currency is totalled in this one: the cards are American, and so is she. */
export const NET_CURRENCY = 'USD';

/**
 * What the net worth can be read in (ACCT-16): dollars first, and euros, the other currency
 * she holds and the one view no American app gives her.
 */
export const NET_CURRENCIES = ['USD', 'EUR'] as const;

export type NetCurrency = (typeof NET_CURRENCIES)[number];

/**
 * The pairs the nightly job reads, each as the ECB publishes it: euros are its base, so the
 * euro rate is the published figure itself, never a cross rate computed here.
 */
export const RATE_PAIRS = [{ base: 'EUR', quote: 'USD' }] as const;

const code = z.string().regex(/^[A-Z]{3}$/);
const isoDate = z.iso.date();

/**
 * Frankfurter v2's `/rates` answer: `[{date, base, quote, rate}]`. Asked with
 * `providers=ECB`; without it v2 blends other central banks' rates in and answers for
 * weekends too — on 24 Sep 2026 it gave 1.1492 for 18 Sep where the ECB's was 1.146.
 */
export const frankfurterSchema = z.array(
  z.object({ date: isoDate, base: code, quote: code, rate: z.number().positive() }),
);

/** A rate as the job stores it: `rate` as decimal text, so the ECB's digits are the stored ones. */
export type NewRate = {
  readonly source: typeof RATE_SOURCE;
  readonly base: string;
  readonly quote: string;
  readonly rate_date: string;
  readonly rate: string;
};

/**
 * Frankfurter sends the rate as a JSON number, so it arrives as a float; `String` gives back
 * the shortest text that reads as the same float, which is the text Frankfurter wrote as long
 * as it wrote no more than 15 significant digits. The ECB publishes at most 6 (USD: 1.1367).
 * An exponent (`1e-7`) is refused rather than expanded: no ECB rate is that small.
 */
export function rateText(rate: number): string | null {
  const text = String(rate);
  return /^\d+(\.\d+)?$/.test(text) && rate > 0 ? text : null;
}

export type ReadRates = { readonly ok: true; readonly rates: NewRate[] } | { readonly ok: false };

export function toNewRates(raw: z.output<typeof frankfurterSchema>): ReadRates {
  const rates: NewRate[] = [];
  for (const row of raw) {
    const rate = rateText(row.rate);
    if (rate === null || row.base === row.quote) return { ok: false };
    rates.push({
      source: RATE_SOURCE,
      base: row.base,
      quote: row.quote,
      rate_date: row.date,
      rate,
    });
  }
  return { ok: true, rates };
}

/* ─── the stored rate, as the app reads it ──────────────────────────────────────────────── */

/** Selected as `rate::text`: PostgREST sends a bare numeric as a JSON number, a float again. */
export const rateRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  source: z.literal(RATE_SOURCE),
  base: code,
  quote: code,
  rate_date: isoDate,
  rate: z.string().regex(/^\d+(\.\d+)?$/),
});

export type RateRow = z.output<typeof rateRowSchema>;

/** Newest first: the order the rate a total uses is found in. */
export function compareRates(a: RateRow, b: RateRow): number {
  return b.rate_date.localeCompare(a.rate_date) || a.id.localeCompare(b.id);
}

/**
 * The newest live rate for one base in one quote, or null when none has been read. With
 * `onOrBefore`, the newest dated that day or earlier: a past day's total uses the rate that
 * day had, which no later read can change (ACCT-03).
 */
export function latestRate(
  rates: readonly RateRow[],
  base: string,
  quote: string,
  onOrBefore?: string,
): RateRow | null {
  let latest: RateRow | null = null;
  for (const rate of rates) {
    if (rate.deleted_at !== null || rate.base !== base || rate.quote !== quote) continue;
    // ISO dates: lexical order is date order.
    if (onOrBefore !== undefined && rate.rate_date > onOrBefore) continue;
    if (latest === null || rate.rate_date > latest.rate_date) latest = rate;
  }
  return latest;
}

/* ─── converting ────────────────────────────────────────────────────────────────────────── */

/**
 * `minor` of `from` in minor units of `to`, at `rate` (one `from` is `rate` of `to`).
 *
 * All in bigint: the rate's decimal text becomes an integer and a power of ten, and there is
 * one division, at the end. Rounded half away from zero, to the cent — how a person rounds
 * by hand, and a sum of one rounding per currency (never per account) cannot drift further
 * than half a cent per currency. Null for a rate that is not decimal text or a currency that
 * is not an ISO code.
 */
export function convertMinor(minor: bigint, from: string, to: string, rate: string): bigint | null {
  const fromDigits = minorDigits(from);
  const toDigits = minorDigits(to);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (fromDigits === null || toDigits === null || match === null) return null;
  const [, whole = '', fraction = ''] = match;
  const units = BigInt(whole + fraction);
  let numerator = minor * units * 10n ** BigInt(Math.max(0, toDigits - fromDigits));
  const denominator = 10n ** BigInt(fraction.length + Math.max(0, fromDigits - toDigits));
  const negative = numerator < 0n;
  if (negative) numerator = -numerator;
  const quotient = (numerator + denominator / 2n) / denominator;
  return negative ? -quotient : quotient;
}

/**
 * The newest live rate that converts `from` into `to`, as published or the other way round,
 * or null when neither has been read. The ECB publishes only euros as the base, so a total in
 * euros (ACCT-16) reads the EUR→USD row backwards rather than a second rate computed and kept
 * here: the figure shown beside it is still one the ECB published, with its date. On one day
 * the published direction wins.
 */
export function rateBetween(
  rates: readonly RateRow[],
  from: string,
  to: string,
  onOrBefore?: string,
): RateRow | null {
  const direct = latestRate(rates, from, to, onOrBefore);
  const inverse = latestRate(rates, to, from, onOrBefore);
  if (direct === null) return inverse;
  if (inverse === null) return direct;
  return inverse.rate_date > direct.rate_date ? inverse : direct;
}

/**
 * `minor` of `from` in minor units of `to`, at a stored rate read whichever way it was
 * published: multiplied when it is `from`→`to`, divided when it is `to`→`from`. Divided
 * in bigint like `convertMinor`, one division and rounded half away from zero. Null for a rate
 * between other currencies, or one that is not decimal text or not above zero.
 */
export function convertAt(minor: bigint, from: string, to: string, rate: RateRow): bigint | null {
  if (rate.base === from && rate.quote === to) return convertMinor(minor, from, to, rate.rate);
  if (rate.base !== to || rate.quote !== from) return null;
  const fromDigits = minorDigits(from);
  const toDigits = minorDigits(to);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate.rate);
  if (fromDigits === null || toDigits === null || match === null) return null;
  const [, whole = '', fraction = ''] = match;
  const units = BigInt(whole + fraction);
  if (units === 0n) return null;
  let numerator =
    minor * 10n ** BigInt(fraction.length) * 10n ** BigInt(Math.max(0, toDigits - fromDigits));
  const denominator = units * 10n ** BigInt(Math.max(0, fromDigits - toDigits));
  const negative = numerator < 0n;
  if (negative) numerator = -numerator;
  // Doubled, so half of an odd denominator is not truncated away.
  const quotient = (2n * numerator + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

export type Conversion = {
  readonly currency: string;
  readonly minor: bigint;
  readonly converted: bigint;
  /** As stored, in the direction the ECB published it: it may be `currency`'s, read backwards. */
  readonly rate: RateRow;
};

export type Sum =
  | {
      readonly kind: 'summed';
      readonly currency: string;
      readonly minor: bigint;
      readonly accounts: number;
      /** One per currency that was converted, with the stored rate it used (invariant 3). */
      readonly conversions: readonly Conversion[];
    }
  /** Some currency has no rate into `currency`: the sum is left unsaid, not left short. */
  | { readonly kind: 'unrated'; readonly missing: readonly string[] };

/**
 * Every currency's total in `currency`, each at its newest stored rate, or the newest on or
 * before `onOrBefore`. The totals are converted, not the accounts: one rounding per currency.
 * A currency with no rate leaves the whole sum unsaid rather than a total that quietly leaves
 * an account out. No totals sum to zero.
 */
export function sumIn(
  totals: readonly Total[],
  rates: readonly RateRow[],
  currency = NET_CURRENCY,
  onOrBefore?: string,
): Sum {
  let minor = 0n;
  let accounts = 0;
  const conversions: Conversion[] = [];
  const missing: string[] = [];
  for (const total of totals) {
    accounts += total.accounts;
    if (total.currency === currency) {
      minor += total.minor;
      continue;
    }
    const rate = rateBetween(rates, total.currency, currency, onOrBefore);
    const converted = rate === null ? null : convertAt(total.minor, total.currency, currency, rate);
    if (rate === null || converted === null) {
      missing.push(total.currency);
      continue;
    }
    minor += converted;
    conversions.push({ currency: total.currency, minor: total.minor, converted, rate });
  }
  if (missing.length > 0) return { kind: 'unrated', missing };
  return { kind: 'summed', currency, minor, accounts, conversions };
}

/* ─── how old a rate is ─────────────────────────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Past this many days, the rate has missed a publication the nightly job should have read.
 * Easter sets it: the ECB publishes nothing on Good Friday or Easter Monday, so Thursday's
 * rate is the newest until Tuesday's is read at 09:00 UTC on Wednesday — six days. A normal
 * weekend is at most four (Friday's, until Tuesday's run reads Monday's).
 */
export const RATE_STALE_AFTER_DAYS = 6;

/** Whole days from the rate's date to `now`'s date in UTC, the ECB's calendar near enough. */
export function rateAgeDays(rateDate: string, now: number): number {
  const today = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  return Math.round((today - Date.parse(`${rateDate}T00:00:00Z`)) / DAY_MS);
}

export function isRateStale(rateDate: string, now: number): boolean {
  return rateAgeDays(rateDate, now) > RATE_STALE_AFTER_DAYS;
}

/** "Friday 18 September": the weekday is what tells a Sunday reader it is Friday's rate. */
export function describeRateDate(rateDate: string, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(Date.parse(`${rateDate}T00:00:00Z`));
}
