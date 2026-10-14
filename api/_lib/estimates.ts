/**
 * The weekly estimate read (ACCT-11): RentCast for a home, MarketCheck for a car, stored in
 * `asset_values` as `estimate` rows beside Nora's own. Runs in the nightly cron request beside
 * the bank pull and the rates, and fails on its own.
 *
 * Each asset is asked once a week (`ESTIMATE_EVERY_DAYS`), so most nights this reads two rows
 * and asks nobody. A night Vercel delivers twice writes nothing twice: a day's estimate is
 * unique per asset and provider, and inserted with ON CONFLICT DO NOTHING.
 *
 * RentCast's free plan is 50 calls a month (Nora, 25 Sep: "let's be smart about them"), so
 * only the first of the two nightly runs asks anybody (`ASKS_BEFORE_HOUR_UTC`). A provider
 * that fails is asked again the next day, not two hours later: the worst month, every day
 * failing, is 31 calls, and an ordinary one is four or five.
 *
 * A provider whose key is not set is skipped, not failed: the car is asked about only once
 * she has given a key for it, and until then the home's estimates still arrive.
 *
 * What it logs is counts and provider names (invariant 4). The address and the VIN are sent
 * to the provider that needs them and never appear in an outcome; nor does a URL, since
 * MarketCheck's key rides in its query string.
 */
import { z } from 'zod';

import type { Lookup, NewEstimate, Provider } from '../../packages/core/src/estimates.ts';
import {
  due,
  estimableSchema,
  fromMarketcheck,
  fromRentcast,
  lastEstimated,
  lookupOf,
  marketcheckSchema,
  PROVIDER_NAMES,
  PROVIDERS,
  rentcastSchema,
} from '../../packages/core/src/estimates.ts';
import { parse } from '../../packages/core/src/parse.ts';
import type { Supabase } from './nightly.ts';
import { owner } from './nightly.ts';

export const RENTCAST_URL = 'https://api.rentcast.io/v1/avm/value';

export const MARKETCHECK_URL = 'https://api.marketcheck.com/v2/predict/car/us/marketcheck_price';

/**
 * A bound on a hang, not a measured answer time: neither provider had been called from here
 * when this was written. It runs beside the bank pull, which waits far longer on the Bridge.
 */
export const ESTIMATE_TIMEOUT_MS = 20_000;

/**
 * The cron runs at 09:00 and 11:00 UTC (vercel.json), each firing anywhere inside its hour on
 * Hobby. Only a run before 10:00 asks, so a day has one attempt at most.
 */
export const ASKS_BEFORE_HOUR_UTC = 10;

export type EstimatesEnv = {
  readonly SUPABASE_URL?: string | undefined;
  readonly SUPABASE_SECRET_KEY?: string | undefined;
  readonly RENTCAST_API_KEY?: string | undefined;
  readonly MARKETCHECK_API_KEY?: string | undefined;
};

/** What the run answers the cron with. Counts and provider names only: Vercel logs it. */
export type EstimatesOutcome =
  | {
      readonly ok: true;
      readonly asked: number;
      /** The later run of the day, which asks nobody. */
      readonly later: boolean;
      readonly stored: number;
      /** Providers with an asset to ask about and no key to ask with. */
      readonly unconfigured: readonly Provider[];
    }
  | { readonly ok: false; readonly reason: string };

const valueDaysSchema = z.array(
  z.object({ asset_id: z.string(), provider: z.string().nullable(), valued_on: z.iso.date() }),
);

function keyFor(env: EstimatesEnv, provider: Provider): string {
  return (provider === 'rentcast' ? env.RENTCAST_API_KEY : env.MARKETCHECK_API_KEY) ?? '';
}

/** The request for a lookup. RentCast takes its key as a header, MarketCheck in the query. */
export function requestFor(
  lookup: Lookup,
  key: string,
): { url: string; headers: Record<string, string> } {
  if (lookup.provider === 'rentcast') {
    // No type, size or rooms: RentCast looks them up from its own records
    // (`lookupSubjectAttributes`, on by default), and on 7 Oct 2026 it had the apartment right,
    // the right size and rooms, so sending them changed nothing (DIN-8). What moved the price
    // was the comparables: its default 15 gave $284,000, 25 listed within a year $311,000,
    // against Zillow's $356,000 and Monarch's $322,600 (21 Sep). One call each; compCount
    // and daysOld were not tried apart, and a radius of 0.5 or 1 mile changed nothing.
    const query = new URLSearchParams({ address: lookup.address, compCount: '25', daysOld: '365' });
    return {
      url: `${RENTCAST_URL}?${query.toString()}`,
      headers: { Accept: 'application/json', 'X-Api-Key': key },
    };
  }
  // `franchise`: what a Honda dealer would ask for it. The price is dealer retail either way,
  // above what a private sale or a trade-in would bring, and the screen says so.
  const query = new URLSearchParams({
    api_key: key,
    vin: lookup.vin,
    miles: String(lookup.miles),
    zip: lookup.postalCode,
    dealer_type: 'franchise',
  });
  return { url: `${MARKETCHECK_URL}?${query.toString()}`, headers: { Accept: 'application/json' } };
}

async function ask(
  fetchFn: typeof fetch,
  lookup: Lookup,
  key: string,
  today: string,
): Promise<{ ok: true; row: NewEstimate } | { ok: false; reason: string }> {
  const name = PROVIDER_NAMES[lookup.provider];
  const { url, headers } = requestFor(lookup, key);
  let response: Response;
  try {
    response = await fetchFn(url, { headers, signal: AbortSignal.timeout(ESTIMATE_TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: `${name} did not answer` };
  }
  if (!response.ok) return { ok: false, reason: `${name} answered HTTP ${response.status}` };
  const body: unknown = await response.json().catch(() => null);
  const row =
    lookup.provider === 'rentcast'
      ? parseThen(rentcastSchema, body, (a) => fromRentcast(a, lookup.assetId, today))
      : parseThen(marketcheckSchema, body, (a) => fromMarketcheck(a, lookup.assetId, today));
  if (row === null) return { ok: false, reason: `${name} answered with no price` };
  return { ok: true, row };
}

function parseThen<Answer>(
  schema: z.ZodType<Answer>,
  body: unknown,
  then: (answer: Answer) => NewEstimate | null,
): NewEstimate | null {
  const parsed = parse(schema, body);
  return parsed.ok ? then(parsed.value) : null;
}

export async function estimates(
  env: EstimatesEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<EstimatesOutcome> {
  const later = now.getUTCHours() >= ASKS_BEFORE_HOUR_UTC;
  if (later) return { ok: true, asked: 0, later, stored: 0, unconfigured: [] };
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

  const [assetsResponse, valuesResponse] = await Promise.all([
    db.fetch(
      `${db.url}/rest/v1/assets?select=id,kind,currency,address,postal_code,vin,odometer_miles,odometer_on,deleted_at&${mine}&deleted_at=is.null`,
      { headers: db.headers },
    ),
    db.fetch(
      `${db.url}/rest/v1/asset_values?select=asset_id,provider,valued_on&${mine}&source=eq.estimate&deleted_at=is.null`,
      { headers: db.headers },
    ),
  ]);
  if (!assetsResponse.ok) {
    return { ok: false, reason: `reading assets answered HTTP ${assetsResponse.status}` };
  }
  if (!valuesResponse.ok) {
    return { ok: false, reason: `reading estimates answered HTTP ${valuesResponse.status}` };
  }
  const assets = parse(z.array(estimableSchema), await assetsResponse.json());
  const days = parse(valueDaysSchema, await valuesResponse.json());
  if (!assets.ok || !days.ok)
    return { ok: false, reason: 'reading assets answered in an unexpected shape' };

  const last = new Map(PROVIDERS.map((p) => [p, lastEstimated(days.value, p)]));
  const unconfigured = new Set<Provider>();
  const asking: { lookup: Lookup; key: string }[] = [];
  for (const asset of assets.value) {
    const lookup = lookupOf(asset);
    if (lookup === null) continue;
    if (!due(last.get(lookup.provider)?.get(lookup.assetId) ?? null, today)) continue;
    const key = keyFor(env, lookup.provider);
    if (key === '') unconfigured.add(lookup.provider);
    else asking.push({ lookup, key });
  }

  const answers = await Promise.all(asking.map((a) => ask(fetchFn, a.lookup, a.key, today)));
  const rows: NewEstimate[] = [];
  const failures: string[] = [];
  for (const answer of answers) {
    if (answer.ok) rows.push(answer.row);
    else failures.push(answer.reason);
  }

  if (rows.length > 0) {
    const response = await db.fetch(
      `${db.url}/rest/v1/asset_values?on_conflict=user_id,asset_id,provider,valued_on`,
      {
        method: 'POST',
        headers: {
          ...db.headers,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify(rows.map((row) => ({ ...row, user_id: who.id }))),
      },
    );
    if (!response.ok) {
      return { ok: false, reason: `storing estimates answered HTTP ${response.status}` };
    }
  }
  // Stored what answered, and failed for what did not: one provider down should neither
  // lose the other's estimate nor pass unnoticed.
  if (failures.length > 0) return { ok: false, reason: failures.join('; ') };
  return {
    ok: true,
    asked: asking.length,
    later,
    stored: rows.length,
    unconfigured: [...unconfigured].sort(),
  };
}
