/**
 * Reading a source again from the app (BANK-18): a night's read, run now. Found 28 Sep 2026:
 * SUMMIT's four accounts were 40 hours old and the home screen's amber rows offered nothing,
 * because a read was something only the cron did. This is the same read, `nightly` or
 * `plaidNightly`, stored through the same `bank_store`, so what it fetches reaches the page
 * the way every morning's does, and a `bank_pulls` row says it happened.
 *
 * Who may ask is `signedIn` (BANK-12's rule): the one person the banks are read for. What
 * it costs: a SimpleFIN read is two of the Bridge's 24 requests a day (`NIGHTLY_WINDOWS`),
 * a Plaid read about four requests, free on the Trial plan. Nothing here answers with a
 * credential or a row: the page reads the rows from the database as it always has.
 */
import { parse } from '../../packages/core/src/parse.ts';
import { readRequestSchema } from '../../packages/core/src/reading.ts';
import type { ReadAnswer, ReadSource } from '../../packages/core/src/reading.ts';
import { nightly, plaidNightly } from './nightly.ts';
import type { PlaidNightlyEnv, Supabase } from './nightly.ts';
import { signedIn } from './session.ts';

const DATABASE = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const;

const REQUIRED: Readonly<Record<ReadSource, readonly (keyof PlaidNightlyEnv)[]>> = {
  simplefin: ['SIMPLEFIN_ACCESS_URL'],
  plaid: ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ACCESS_TOKENS'],
};

type Answered = { readonly status: number; readonly answer: ReadAnswer };

function refused(status: number, reason: string): Answered {
  return { status, answer: { kind: 'refused', reason } };
}

function unset(env: PlaidNightlyEnv, keys: readonly (keyof PlaidNightlyEnv)[]): string[] {
  return keys.filter((k) => (env[k] ?? '').trim() === '');
}

export async function readAgain(
  request: Request,
  env: PlaidNightlyEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<Answered> {
  const absent = unset(env, DATABASE);
  if (absent.length > 0) return refused(503, `not configured: ${absent.join(', ')}`);

  const key = env.SUPABASE_SECRET_KEY ?? '';
  const db: Supabase = {
    url: (env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    fetch: fetchFn,
  };
  const denied = await signedIn(request, db);
  if (denied !== null) return refused(denied.status, denied.reason);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const asked = parse(readRequestSchema, body);
  if (!asked.ok) return refused(400, 'expected a source: simplefin or plaid');
  const { source } = asked.value;

  const missing = unset(env, REQUIRED[source]);
  if (missing.length > 0) return refused(503, `not configured: ${missing.join(', ')}`);

  const read =
    source === 'simplefin'
      ? await nightly(env, fetchFn, now)
      : await plaidNightly(env, fetchFn, now);
  return {
    status: 200,
    answer: read.ok ? { kind: 'read' } : { kind: 'failed', reason: read.reason },
  };
}
