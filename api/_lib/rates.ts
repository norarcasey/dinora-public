/**
 * The nightly rate read (ACCT-02): the ECB's reference rates for the last 90 days, through
 * Frankfurter, stored in `fx_rates` for the one user. Runs beside the bank pull in the same
 * cron request, and fails on its own: a total a day behind on its rate is still a total,
 * and says which day's rate it used.
 *
 * All 90 days every night, not "since the last success", for the bank pull's reason: a
 * skipped night costs nothing and a doubled one changes nothing. Rows are inserted with ON
 * CONFLICT DO NOTHING, so a date already stored keeps the rate it was first stored with and
 * a total shown with it can be shown again (invariant 3). 90 because that is the history the
 * Bridge gives (BANK-01): from the first night, every day a transaction can be dated has a
 * rate beside it.
 */
import { parse } from '../../packages/core/src/parse.ts';
import { frankfurterSchema, RATE_PAIRS, toNewRates } from '../../packages/core/src/rates.ts';
import type { NewRate } from '../../packages/core/src/rates.ts';
import type { NightlyEnv, Supabase } from './nightly.ts';
import { owner } from './nightly.ts';

export const RATES_URL = 'https://api.frankfurter.dev/v2/rates';

export const RATE_DAYS = 90;

/**
 * Frankfurter answered the 90-day read (68 rates) in 0.25 s, three times running, from a
 * laptop in Spain on 24 Sep 2026. It runs while the bank pull waits on the Bridge, so this
 * bounds nothing but a hang.
 */
export const RATES_TIMEOUT_MS = 20_000;

/** What the run answers the cron with. Counts and dates only: Vercel logs it. */
export type RatesOutcome =
  | { readonly ok: true; readonly read: number; readonly newest: string | null }
  | { readonly ok: false; readonly reason: string };

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * `providers=ECB` is what makes these the ECB's rates. Without it Frankfurter v2 blends in
 * other central banks' and answers for weekends; with it a Sunday is Friday, dated Friday.
 */
export function ratesUrl(base: string, quote: string, now: Date): string {
  const query = new URLSearchParams({
    base,
    quotes: quote,
    providers: 'ECB',
    from: day(now.getTime() - RATE_DAYS * 24 * 60 * 60 * 1000),
    to: day(now.getTime()),
  });
  return `${RATES_URL}?${query.toString()}`;
}

async function read(
  fetchFn: typeof fetch,
  base: string,
  quote: string,
  now: Date,
): Promise<{ ok: true; rates: NewRate[] } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetchFn(ratesUrl(base, quote, now), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(RATES_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: `Frankfurter did not answer for ${base} to ${quote}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `Frankfurter answered HTTP ${response.status}` };
  }
  const parsed = parse(frankfurterSchema, await response.json().catch(() => null));
  const rates = parsed.ok ? toNewRates(parsed.value) : { ok: false as const };
  if (!rates.ok) return { ok: false, reason: 'Frankfurter answered in an unexpected shape' };
  // Asked for one pair; a row for another is an answer to a different question.
  if (rates.rates.some((r) => r.base !== base || r.quote !== quote)) {
    return { ok: false, reason: 'Frankfurter answered for a pair it was not asked for' };
  }
  return { ok: true, rates: rates.rates };
}

export async function rates(
  env: NightlyEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<RatesOutcome> {
  const url = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SECRET_KEY ?? '';
  if (url === '' || key === '') {
    return { ok: false, reason: 'not configured: SUPABASE_URL, SUPABASE_SECRET_KEY' };
  }
  const db: Supabase = {
    url,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    fetch: fetchFn,
  };

  const [who, answers] = await Promise.all([
    owner(db),
    Promise.all(RATE_PAIRS.map((pair) => read(fetchFn, pair.base, pair.quote, now))),
  ]);
  if ('reason' in who) return { ok: false, reason: who.reason };
  const rows: NewRate[] = [];
  for (const answer of answers) {
    if (!answer.ok) return { ok: false, reason: answer.reason };
    rows.push(...answer.rates);
  }
  if (rows.length === 0) return { ok: true, read: 0, newest: null };

  const response = await db.fetch(
    `${db.url}/rest/v1/fx_rates?on_conflict=user_id,source,base,quote,rate_date`,
    {
      method: 'POST',
      headers: {
        ...db.headers,
        'Content-Type': 'application/json',
        // ON CONFLICT DO NOTHING: a stored rate is what some total used, and stays.
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(rows.map((row) => ({ ...row, user_id: who.id }))),
    },
  );
  if (!response.ok) return { ok: false, reason: `storing rates answered HTTP ${response.status}` };

  const newest = rows.reduce((max, r) => (r.rate_date > max ? r.rate_date : max), '');
  return { ok: true, read: rows.length, newest };
}
