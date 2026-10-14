/**
 * The nightly metal read (ACCT-12): the LBMA's daily price for each metal Nora owns, stored in
 * `metal_prices`, and each piece's value at the newest of them, stored in `asset_values` as an
 * `lbma` estimate. Runs in the nightly cron request beside the others, and fails on its own.
 *
 * Nothing is asked for until she says what a piece weighs: with no metal among her assets the
 * run reads one table and stops. The LBMA's files are free and unmetered, so both nightly runs
 * read them; the second writes nothing unless the first failed, since a day's price and a
 * day's value are each unique and inserted with ON CONFLICT DO NOTHING.
 *
 * Prices are kept from a week before the oldest purchase, so what gold has done since the day
 * she bought it can be read (`metalWorth`). The first night after a purchase day is entered
 * sends that backlog, about 1,150 business days from March 2022 (counted 25 Sep 2026); every
 * night after sends the day or two the LBMA has added.
 *
 * What it logs is counts and dates (invariant 4). The LBMA's prices are nobody's secret, but
 * a value is hers, and neither appears in an outcome.
 */
import { z } from 'zod';

import type { NewEstimate } from '../../packages/core/src/estimates.ts';
import type { Metal, NewPrice, PriceNeed } from '../../packages/core/src/metals.ts';
import {
  dayBefore,
  lbmaSchema,
  priceNeeds,
  toNewPrices,
  unstored,
  valuableSchema,
  valuesToStore,
} from '../../packages/core/src/metals.ts';
import { parse } from '../../packages/core/src/parse.ts';
import type { NightlyEnv, Supabase } from './nightly.ts';
import { owner } from './nightly.ts';

/** The afternoon price for gold (there is a morning one too) and the one daily price for silver. */
export const LBMA_URLS: Readonly<Record<Metal, string>> = {
  gold: 'https://prices.lbma.org.uk/json/gold_pm.json',
  silver: 'https://prices.lbma.org.uk/json/silver.json',
};

/**
 * Each file answered in 1.7 s, about 900 KB, three times running from a laptop in Spain on 25
 * Sep 2026. It runs while the bank pull waits on the Bridge, so this bounds nothing but a hang.
 */
export const LBMA_TIMEOUT_MS = 20_000;

/**
 * How far back the job looks for the last value it stored for each piece. It writes one each
 * business day, so a month always finds it; a piece with none in a month is due anyway, and
 * the read stays under PostgREST's 1,000 rows however many years of values there are.
 */
export const VALUES_LOOKBACK_DAYS = 30;

/** What the run answers the cron with. Counts and dates only: Vercel logs it. */
export type MetalsOutcome =
  | {
      readonly ok: true;
      /** Prices sent to be stored, backlog included. */
      readonly prices: number;
      /** Values worked out and sent, one per piece per new price day. */
      readonly values: number;
      /** The LBMA's newest day for each metal asked about. */
      readonly newest: Readonly<Partial<Record<Metal, string>>>;
    }
  | { readonly ok: false; readonly reason: string };

const dateRowsSchema = z.array(z.object({ price_date: z.iso.date() }));

const valueDaysSchema = z.array(z.object({ asset_id: z.string(), valued_on: z.iso.date() }));

type Failure = { readonly ok: false; readonly reason: string };

async function readFile(
  fetchFn: typeof fetch,
  metal: Metal,
): Promise<{ ok: true; file: z.output<typeof lbmaSchema> } | Failure> {
  let response: Response;
  try {
    response = await fetchFn(LBMA_URLS[metal], {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(LBMA_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: `the LBMA did not answer for ${metal}` };
  }
  if (!response.ok) return { ok: false, reason: `the LBMA answered HTTP ${response.status}` };
  const parsed = parse(lbmaSchema, await response.json().catch(() => null));
  if (!parsed.ok) return { ok: false, reason: `the LBMA's ${metal} file had an unexpected shape` };
  return { ok: true, file: parsed.value };
}

/** The first and last day stored for one metal in one currency, or null for none. */
async function storedRun(
  db: Supabase,
  mine: string,
  need: PriceNeed,
): Promise<{ ok: true; run: { first: string; last: string } | null } | Failure> {
  const ends = await Promise.all(
    (['asc', 'desc'] as const).map((order) =>
      db.fetch(
        `${db.url}/rest/v1/metal_prices?select=price_date&${mine}&source=eq.lbma&metal=eq.${need.metal}&currency=eq.${need.currency}&order=price_date.${order}&limit=1`,
        { headers: db.headers },
      ),
    ),
  );
  const dates: string[] = [];
  for (const response of ends) {
    if (!response.ok)
      return { ok: false, reason: `reading prices answered HTTP ${response.status}` };
    const parsed = parse(dateRowsSchema, await response.json());
    if (!parsed.ok) return { ok: false, reason: 'reading prices answered in an unexpected shape' };
    const [row] = parsed.value;
    if (row !== undefined) dates.push(row.price_date);
  }
  const [first, last] = dates;
  return { ok: true, run: first === undefined || last === undefined ? null : { first, last } };
}

async function insert(
  db: Supabase,
  table: string,
  conflict: string,
  rows: readonly (NewPrice | NewEstimate)[],
  userId: string,
): Promise<Response | null> {
  if (rows.length === 0) return null;
  return db.fetch(`${db.url}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: 'POST',
    headers: {
      ...db.headers,
      'Content-Type': 'application/json',
      // ON CONFLICT DO NOTHING: a stored price is what some value used, and stays.
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows.map((row) => ({ ...row, user_id: userId }))),
  });
}

export async function metals(
  env: NightlyEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<MetalsOutcome> {
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
    `${db.url}/rest/v1/assets?select=id,currency,acquired_on,metal,metal_mg,fineness,deleted_at&${mine}&metal=not.is.null&deleted_at=is.null`,
    { headers: db.headers },
  );
  if (!assetsResponse.ok) {
    return { ok: false, reason: `reading assets answered HTTP ${assetsResponse.status}` };
  }
  const assets = parse(z.array(valuableSchema), await assetsResponse.json());
  if (!assets.ok) return { ok: false, reason: 'reading assets answered in an unexpected shape' };
  const needs = priceNeeds(assets.value, today);
  if (needs.length === 0) return { ok: true, prices: 0, values: 0, newest: {} };

  const reads = await Promise.all(
    [...new Set(needs.map((need) => need.metal))].map(
      async (metal) => [metal, await readFile(fetchFn, metal)] as const,
    ),
  );
  const files = new Map<Metal, z.output<typeof lbmaSchema>>();
  for (const [metal, read] of reads) {
    if (!read.ok) return read;
    files.set(metal, read.file);
  }

  const toStore: NewPrice[] = [];
  const newestPrice = new Map<string, { price_date: string; price: string }>();
  const newest: Partial<Record<Metal, string>> = {};
  for (const need of needs) {
    const prices = toNewPrices(files.get(need.metal) ?? [], need.metal, need.currency, need.from);
    if (prices === null) {
      return { ok: false, reason: `the LBMA's ${need.metal} file had a price that is not decimal` };
    }
    const stored = await storedRun(db, mine, need);
    if (!stored.ok) return stored;
    toStore.push(...unstored(prices, stored.run));
    const last = prices.at(-1);
    if (last !== undefined) {
      newestPrice.set(`${need.metal} ${need.currency}`, last);
      newest[need.metal] = last.price_date;
    }
  }
  const pricesResponse = await insert(
    db,
    'metal_prices',
    'user_id,source,metal,currency,price_date',
    toStore,
    who.id,
  );
  if (pricesResponse !== null && !pricesResponse.ok) {
    return { ok: false, reason: `storing prices answered HTTP ${pricesResponse.status}` };
  }

  const daysResponse = await db.fetch(
    `${db.url}/rest/v1/asset_values?select=asset_id,valued_on&${mine}&provider=eq.lbma&valued_on=gte.${dayBefore(today, VALUES_LOOKBACK_DAYS)}`,
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
  const values = valuesToStore(assets.value, newestPrice, lastValued);
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
  return { ok: true, prices: toStore.length, values: values.length, newest };
}
