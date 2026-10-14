/**
 * Whose session a request carries, for the functions a person calls rather than the cron
 * (BANK-12's relink, BANK-17's join). Written once here so the two cannot drift apart on who
 * may act.
 */
import { z } from 'zod';

import { parse } from '../../packages/core/src/parse.ts';
import { owner } from './nightly.ts';
import type { Supabase } from './nightly.ts';

const userSchema = z.object({ id: z.guid() });

export type Denied = { readonly status: number; readonly reason: string };

/**
 * Null when the request is the one person the banks are read for, else why not. Auth answers
 * for the token, which is what makes it a session rather than a string that looks like one;
 * `owner` is the nightly's own rule (invariant 8), so a second user, should one ever exist, is
 * refused here as it is there.
 */
export async function signedIn(request: Request, db: Supabase): Promise<Denied | null> {
  const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (bearer === undefined) return { status: 401, reason: 'not signed in' };
  const response = await db.fetch(`${db.url}/auth/v1/user`, {
    headers: { apikey: db.headers.apikey ?? '', Authorization: `Bearer ${bearer}` },
  });
  if (!response.ok) return { status: 401, reason: 'not signed in' };
  const user = parse(userSchema, await response.json());
  if (!user.ok) return { status: 401, reason: 'not signed in' };
  const who = await owner(db);
  if ('reason' in who) return { status: 503, reason: who.reason };
  return who.id === user.value.id ? null : { status: 403, reason: 'not the owner of these banks' };
}
