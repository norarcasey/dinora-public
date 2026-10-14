/**
 * Signing a Plaid bank in again from the app (BANK-12): the first function a person calls
 * rather than the cron. `pnpm plaid:relink` (BANK-11) does the same from the Mac's terminal;
 * this is it for the phone, where the home screen says which bank wants it.
 *
 * Two steps. `start` finds the item Plaid marks `ITEM_LOGIN_REQUIRED` and answers with
 * Hosted Link's address for it: Plaid's page on Plaid's origin, so none of Plaid's script
 * runs beside the rows the device keeps. `read` runs the Plaid pull there and then, stored
 * like a night's, so the red failure gives way to a read as soon as she is back.
 *
 * The access tokens never leave the server. The page names no item: the server finds the one
 * Plaid says is broken. And update mode asks for no product (`hostedUpdateRequest`), so a
 * link made here cannot add one, a money-moving one included (invariant 5).
 */
import { parse } from '../../packages/core/src/parse.ts';
import {
  bankName,
  hostedUpdateRequest,
  hostedUrl,
  loginRequired,
  relinkStepSchema,
} from '../../packages/core/src/plaid.ts';
import type { RelinkAnswer } from '../../packages/core/src/plaid.ts';
import { plaidNightly } from './nightly.ts';
import type { PlaidNightlyEnv, Supabase } from './nightly.ts';
import { call, plaidEnv, wellFormed } from './plaid.ts';
import { signedIn } from './session.ts';

const REQUIRED = [
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ACCESS_TOKENS',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
] as const;

type Answered = { readonly status: number; readonly answer: RelinkAnswer };

function refused(status: number, reason: string): Answered {
  return { status, answer: { kind: 'refused', reason } };
}

export async function relink(
  request: Request,
  env: PlaidNightlyEnv,
  fetchFn: typeof fetch,
  now: Date,
): Promise<Answered> {
  const absent = REQUIRED.filter((k) => (env[k] ?? '').trim() === '');
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
  const step = parse(relinkStepSchema, body);
  if (!step.ok) return refused(400, 'expected a step: start or read');

  if (step.value.step === 'read') {
    const read = await plaidNightly(env, fetchFn, now);
    return {
      status: 200,
      answer: read.ok ? { kind: 'read' } : { kind: 'failed', reason: read.reason },
    };
  }

  const clientId = env.PLAID_CLIENT_ID ?? '';
  const secret = env.PLAID_SECRET ?? '';
  const plaid = plaidEnv(env.PLAID_ENV ?? 'production');
  if (plaid === null || !wellFormed(clientId, secret)) {
    return refused(503, "PLAID_CLIENT_ID, PLAID_SECRET or PLAID_ENV is not Plaid's form");
  }
  const keys = { clientId, secret, env: plaid };
  const tokens = (env.PLAID_ACCESS_TOKENS ?? '').split(/\s+/).filter((t) => t !== '');

  const items = await Promise.all(
    tokens.map((access_token) => call(keys, '/item/get', { access_token }, fetchFn)),
  );
  for (const [n, item] of items.entries()) {
    if (!item.ok) return refused(502, `item ${n + 1}: ${item.reason}`);
  }
  const n = items.findIndex((item) => item.ok && loginRequired(item.body));
  const [token, item] = [tokens[n], items[n]];
  if (token === undefined || item === undefined || !item.ok) {
    return { status: 200, answer: { kind: 'none' } };
  }

  const made = await call(keys, '/link/token/create', hostedUpdateRequest(token, 'owner'), fetchFn);
  if (!made.ok) return refused(502, made.reason);
  const url = hostedUrl(made.body);
  if (url === null) return refused(502, 'Plaid made no Hosted Link address');
  return { status: 200, answer: { kind: 'open', bank: bankName(item.body, n), url } };
}
