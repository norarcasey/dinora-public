/**
 * The nightly crypto read (ACCT-21): Gemini's daily close for each coin Nora holds, stored in
 * `crypto_prices`, and each holding's value at the newest of them, stored in `asset_values` as
 * a `gemini` estimate with the quantity it counted. Runs in the nightly cron request beside the
 * others, and fails on its own.
 *
 * Nothing is asked for until she holds a coin: with no crypto among her assets the run reads
 * one table and stops. Gemini's market data is public and needs no key, so this holds no
 * credential of any kind (invariant 5 has nothing to guard here). Both nightly runs read it;
 * the second writes nothing unless the first failed, since a day's close and a day's value
 * are each unique and inserted with ON CONFLICT DO NOTHING.
 *
 * A coin Gemini does not price in dollars is counted and skipped, not failed: it is a typo or
 * a coin Gemini does not list, and failing every night for it would hide the failures that
 * matter. Her page says it has no price yet.
 *
 * What it logs is counts and dates (invariant 4). Not the coins either: which coins she holds
 * is hers, as a payee is.
 */
import { z } from 'zod';

import type { NewCryptoPrice } from '../../packages/core/src/crypto.ts';
import {
  CRYPTO_PRICE_DAYS,
  candlesSchema,
  holdingSchema,
  holdingValuesToStore,
  symbolOf,
  symbolsSchema,
  toNewCryptoPrices,
} from '../../packages/core/src/crypto.ts';
import { dayBefore } from '../../packages/core/src/metals.ts';
import { parse } from '../../packages/core/src/parse.ts';
import type { NightlyEnv, Supabase } from './nightly.ts';
import { owner } from './nightly.ts';

export const GEMINI_URL = 'https://api.gemini.com';

/**
 * The symbols list answered in 0.43 s and a year of daily candles in 0.52–0.66 s, about 23 KB,
 * from a laptop in Spain on 27 Sep 2026. It runs while the bank pull waits on the Bridge, so
 * this bounds nothing but a hang.
 */
export const GEMINI_TIMEOUT_MS = 15_000;

/** As `VALUES_LOOKBACK_DAYS` for metals: a daily value is always found within a month. */
export const VALUES_LOOKBACK_DAYS = 30;

/** What the run answers the cron with. Counts and a date only: Vercel logs it. */
export type CryptoOutcome =
  | {
      readonly ok: true;
      /** Closes sent to be stored; most nights all but one are stored already. */
      readonly prices: number;
      /** Values worked out and sent, one per holding per new close. */
      readonly values: number;
      /** The newest completed day Gemini priced, across the coins asked about. */
      readonly newest: string | null;
      /** Holdings of a coin Gemini does not price in dollars. */
      readonly unlisted: number;
    }
  | { readonly ok: false; readonly reason: string };

type Failure = { readonly ok: false; readonly reason: string };

const valueDaysSchema = z.array(z.object({ asset_id: z.string(), valued_on: z.iso.date() }));

async function ask<T>(
  fetchFn: typeof fetch,
  path: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<{ ok: true; value: T } | Failure> {
  let response: Response;
  try {
    response = await fetchFn(`${GEMINI_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: `Gemini did not answer for ${what}` };
  }
  if (!response.ok) return { ok: false, reason: `Gemini answered HTTP ${response.status}` };
  const parsed = parse(schema, await response.json().catch(() => null));
  if (!parsed.ok) return { ok: false, reason: `Gemini's ${what} had an unexpected shape` };
  return { ok: true, value: parsed.value };
}

async function insert(
  db: Supabase,
  table: string,
  conflict: string,
  rows: readonly object[],
  userId: string,
): Promise<Response | null> {
  if (rows.length === 0) return null;
  return db.fetch(`${db.url}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: 'POST',
    headers: {
      ...db.headers,
      'Content-Type': 'application/json',
      // ON CONFLICT DO NOTHING: a stored close is what some value used, and stays.
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows.map((row) => ({ ...row, user_id: userId }))),
  });
}

export async function coins(
  env: NightlyEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<CryptoOutcome> {
  const today = now.toISOString().slice(0, 10);
  const url = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const secret = env.SUPABASE_SECRET_KEY ?? '';
  if (url === '' || secret === '') {
    return { ok: false, reason: 'not configured: SUPABASE_URL, SUPABASE_SECRET_KEY' };
  }
  const db: Supabase = {
    url,
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
    fetch: fetchFn,
  };
  const who = await owner(db);
  if ('reason' in who) return { ok: false, reason: who.reason };
  const mine = `user_id=eq.${who.id}`;

  const assetsResponse = await db.fetch(
    `${db.url}/rest/v1/assets?select=id,currency,coin,coin_quantity::text,deleted_at&${mine}&kind=eq.crypto&deleted_at=is.null`,
    { headers: db.headers },
  );
  if (!assetsResponse.ok) {
    return { ok: false, reason: `reading assets answered HTTP ${assetsResponse.status}` };
  }
  const holdings = parse(z.array(holdingSchema), await assetsResponse.json());
  if (!holdings.ok) return { ok: false, reason: 'reading assets answered in an unexpected shape' };
  if (holdings.value.length === 0) {
    return { ok: true, prices: 0, values: 0, newest: null, unlisted: 0 };
  }

  const symbols = await ask(fetchFn, '/v1/symbols', symbolsSchema, 'symbols');
  if (!symbols.ok) return symbols;
  const listed = new Set(symbols.value);
  const priced = [...new Set(holdings.value.map((h) => h.coin))].filter((coin) =>
    listed.has(symbolOf(coin)),
  );
  const unlisted = holdings.value.filter((h) => !listed.has(symbolOf(h.coin))).length;

  const from = dayBefore(today, CRYPTO_PRICE_DAYS);
  const toStore: NewCryptoPrice[] = [];
  const newestClose = new Map<string, { price_date: string; price: string }>();
  let newest: string | null = null;
  const reads = await Promise.all(
    priced.map(
      async (coin) =>
        [
          coin,
          await ask(fetchFn, `/v2/candles/${symbolOf(coin)}/1day`, candlesSchema, 'candles'),
        ] as const,
    ),
  );
  for (const [coin, read] of reads) {
    if (!read.ok) return read;
    const prices = toNewCryptoPrices(read.value, coin, from, today);
    if (prices === null) {
      return { ok: false, reason: "Gemini's candles had a day or a close that is not one" };
    }
    toStore.push(...prices);
    const last = prices.at(-1);
    if (last !== undefined) {
      newestClose.set(coin, last);
      if (newest === null || last.price_date > newest) newest = last.price_date;
    }
  }
  const pricesResponse = await insert(
    db,
    'crypto_prices',
    'user_id,source,coin,currency,price_date',
    toStore,
    who.id,
  );
  if (pricesResponse !== null && !pricesResponse.ok) {
    return { ok: false, reason: `storing prices answered HTTP ${pricesResponse.status}` };
  }

  const daysResponse = await db.fetch(
    `${db.url}/rest/v1/asset_values?select=asset_id,valued_on&${mine}&provider=eq.gemini&valued_on=gte.${dayBefore(today, VALUES_LOOKBACK_DAYS)}`,
    { headers: db.headers },
  );
  if (!daysResponse.ok) {
    return { ok: false, reason: `reading values answered HTTP ${daysResponse.status}` };
  }
  const days = parse(valueDaysSchema, await daysResponse.json());
  if (!days.ok) return { ok: false, reason: 'reading values answered in an unexpected shape' };
  // Removed values count as stored: one she took back is not written again for its day.
  const lastValued = new Map<string, string>();
  for (const row of days.value) {
    const held = lastValued.get(row.asset_id);
    if (held === undefined || row.valued_on > held) lastValued.set(row.asset_id, row.valued_on);
  }
  const values = holdingValuesToStore(holdings.value, newestClose, lastValued);
  const valuesResponse = await insert(
    db,
    'asset_values',
    'user_id,asset_id,provider,valued_on',
    values,
    who.id,
  );
  if (valuesResponse !== null && !valuesResponse.ok) {
    return { ok: false, reason: `storing values answered HTTP ${valuesResponse.status}` };
  }
  return { ok: true, prices: toStore.length, values: values.length, newest, unlisted };
}
