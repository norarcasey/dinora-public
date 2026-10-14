import { AuthClient } from '@supabase/auth-js';
import { PostgrestClient } from '@supabase/postgrest-js';

import { env } from '../env.ts';
import { SESSION_STORAGE_KEY } from './remembered.ts';

/**
 * The Supabase client, assembled from the two pieces an app like this uses.
 *
 * `createClient` builds five — auth, PostgREST, realtime, storage, functions — and
 * realtime is constructed eagerly. Nora Bene measured the three it never called at
 * 23.8 kB gzipped on the critical path (PERF-2 there). The cost of wiring it here instead:
 * two packages Supabase treats as internals become direct dependencies, pinned to one
 * version together, and the header rules below are this app's to get right. Every RLS
 * decision rests on them — a request carrying the wrong bearer is either an empty screen
 * or somebody else's rows — so client.test.ts asserts each one.
 *
 * The session lives in localStorage, which is per origin. Nothing here sets a cookie.
 */
const base = env.VITE_SUPABASE_URL.replace(/\/+$/, '');
const key = env.VITE_SUPABASE_ANON_KEY;

export const auth = new AuthClient({
  url: `${base}/auth/v1`,
  // The key twice, because the headers mean different things: `apikey` is how the gateway
  // routes and rate-limits, the bearer is who you are. Before a session exists the key is
  // both, which is what lets a stranger reach the sign-in endpoint at all.
  headers: { Authorization: `Bearer ${key}`, apikey: key },
  // Read back synchronously by `remembered.ts`, which is why the key lives there.
  storageKey: SESSION_STORAGE_KEY,
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
  flowType: 'pkce',
});

/**
 * Every data request carries the key, and the signed-in user's token when there is one.
 * The token is read per request rather than held, because the refresh loop rotates it and
 * a copy would go stale.
 */
async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('apikey')) headers.set('apikey', key);
  if (!headers.has('Authorization')) {
    const { data } = await auth.getSession();
    headers.set('Authorization', `Bearer ${data.session?.access_token ?? key}`);
  }
  return fetch(input, { ...init, headers });
}

const rest = new PostgrestClient(`${base}/rest/v1`, { fetch: authedFetch });

/**
 * What the app calls. Deliberately narrow: anything not here is something the app does
 * not do yet, and adding it is a decision rather than a default.
 */
export const supabase = {
  from: rest.from.bind(rest),
  rpc: rest.rpc.bind(rest),
  auth,
};
