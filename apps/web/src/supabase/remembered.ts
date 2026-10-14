import { isAuthRetryableFetchError } from '@supabase/auth-js';
import { z } from 'zod';

/**
 * The session this device remembers, read before any server is asked.
 *
 * auth-js keeps the session in localStorage, and `getSession()` reads it from there — except
 * that when the access token is near expiry, which it always is for an app opened the morning
 * after, it refreshes over the network *before* answering: retrying for up to thirty seconds,
 * then returning `session: null` with a retryable fetch error. Read as "signed out", that put
 * a sign-in form in front of somebody on a plane after half a minute of spinner (Nora Bene,
 * `OFF-1`).
 *
 * So the app renders from what is stored, synchronously, and judges the server's answer
 * afterwards. Signed out is a server's decision; offline is the state where no server has made
 * one. A remembered session grants nothing: every request still carries the stored token, and
 * RLS still answers to it.
 *
 * Pure, because the situation cannot be provoked in jsdom — the decision is a function of its
 * inputs and is tested as one.
 */

/** The key `client.ts` gives auth-js. Namespaced so two apps on one origin never share one. */
export const SESSION_STORAGE_KEY = 'dinora.auth';

export type SessionUser = { readonly id: string; readonly email: string };

/**
 * What a stored session must hold for the app to render from it. Expiry is deliberately not
 * inspected: an expired access token is the case this exists for.
 *
 * `z.guid()`, not `z.uuid()`: Zod 4's `uuid` checks the RFC variant bits and refuses ids like
 * the seed's `11111111-…`, which Postgres accepts. A remembered session that refused a real
 * user would be this whole file failing closed for no reason.
 */
const storedUserSchema = z.object({ id: z.guid(), email: z.string().nullish() });

const storedSessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  user: storedUserSchema,
});

export function sessionUserOf(user: z.infer<typeof storedUserSchema>): SessionUser {
  return { id: user.id, email: user.email ?? '' };
}

/**
 * The stored session as written, or null. Synchronous — the property all of this rests on: it
 * lets the first render know who it is for, and lets the row cache name whose rows to read off
 * disk before React mounts.
 */
export function readStoredSession(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  try {
    return storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage refused (private mode, a locked profile): nothing is remembered.
    return null;
  }
}

/** The user a stored session names, or null when nothing usable is stored. Never throws. */
export function rememberedUser(raw: string | null): SessionUser | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = storedSessionSchema.safeParse(parsed);
  return result.success ? sessionUserOf(result.data.user) : null;
}

export type ServerAnswer = {
  readonly session: { readonly user: { readonly id: string; readonly email?: string } } | null;
  readonly error: unknown;
};

export type Verdict =
  | { readonly kind: 'signed-in'; readonly user: SessionUser }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unreachable' };

/**
 * What `getSession()` said, sorted into the three things it can mean. A failed fetch is no
 * answer, and whatever was remembered stands; any other empty answer is a server saying no.
 */
export function judge(answer: ServerAnswer): Verdict {
  if (answer.session !== null) {
    return { kind: 'signed-in', user: sessionUserOf(answer.session.user) };
  }
  if (isAuthRetryableFetchError(answer.error)) return { kind: 'unreachable' };
  return { kind: 'signed-out' };
}
