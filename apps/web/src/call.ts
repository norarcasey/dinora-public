import { parse } from '@dinora/core/parse';
import type { z } from 'zod';

import { auth } from './supabase/client.ts';

export type Refused = { readonly kind: 'refused'; readonly reason: string };

/**
 * One call to a function of Dinora's own, as the signed-in session: BANK-12's sign-in and
 * BANK-18's read. The session's token goes as the bearer, which the function asks Auth about
 * (`signedIn`); the answer is parsed with the function's own schema, and anything else is
 * said as a refusal in the words the page already shows, so a page never reads a body it did
 * not expect. Written once here when the second function arrived, so the two cannot differ
 * on how a call is made.
 */
export async function callSigned<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S> | Refused> {
  const { data } = await auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined) return { kind: 'refused', reason: 'not signed in' };
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'refused', reason: 'Dinora could not be reached' };
  }
  let answered: unknown;
  try {
    answered = await response.json();
  } catch {
    answered = null;
  }
  const answer = parse(schema, answered);
  return answer.ok
    ? answer.value
    : { kind: 'refused', reason: `it answered HTTP ${response.status}` };
}
