/**
 * Putting a Monarch copy and its bank account together from the app (BANK-17): the home
 * screen's *may be counted twice* flag, tapped and confirmed, instead of `pnpm monarch:import
 * --link` on the Mac (BANK-15).
 *
 * Everything is `monarch_join`, in one transaction as service_role: the rows move, the copy is
 * retired, and the link is kept as a decision. This checks who is asking, sends Dinora's two
 * ids, and turns a refusal into her words.
 */
import { z } from 'zod';

import type { JoinAnswer } from '../../packages/core/src/doubles.ts';
import { joinRefusal, joinRequestSchema, joinedSchema } from '../../packages/core/src/doubles.ts';
import { parse } from '../../packages/core/src/parse.ts';
import { owner } from './nightly.ts';
import type { Supabase } from './nightly.ts';
import { signedIn } from './session.ts';

export type JoinEnv = Readonly<Record<string, string | undefined>>;

type Answered = { readonly status: number; readonly answer: JoinAnswer };

function refused(status: number, reason: string): Answered {
  return { status, answer: { kind: 'refused', reason } };
}

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const;

const errorSchema = z.object({ message: z.string() });

export async function join(
  request: Request,
  env: JoinEnv,
  fetchFn: typeof fetch,
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
  const asked = parse(joinRequestSchema, body);
  if (!asked.ok) return refused(400, 'expected two account ids');

  // `signedIn` has already matched the session to the owner; asked again for the id to send.
  const who = await owner(db);
  if ('reason' in who) return refused(503, who.reason);

  const response = await fetchFn(`${db.url}/rest/v1/rpc/monarch_join`, {
    method: 'POST',
    headers: { ...db.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: who.id, p_copy: asked.value.monarch, p_bank: asked.value.bank }),
  });
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (!response.ok) {
    // PostgREST's `message` is the raise's text. Only a known code is passed on, never the
    // message itself, which for an unknown error could quote a row (invariant 4).
    const said = parse(errorSchema, answer);
    const reason = said.ok ? joinRefusal(said.value.message) : null;
    return reason === null
      ? refused(502, `the database answered HTTP ${response.status}`)
      : refused(409, reason);
  }
  const joined = parse(joinedSchema, answer);
  if (!joined.ok) return refused(502, 'the database answered in an unexpected shape');
  return { status: 200, answer: { kind: 'joined', ...joined.value } };
}
