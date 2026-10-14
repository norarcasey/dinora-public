/**
 * The headers every data request carries, which every RLS decision rests on. `createClient`
 * used to do this wiring; now it is ours (see client.ts), so each rule is pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'sb_publishable_TESTKEY';
const session: { token: string | null } = { token: null };

vi.mock('../env.ts', () => ({
  env: { VITE_SUPABASE_URL: 'https://example.supabase.co/', VITE_SUPABASE_ANON_KEY: KEY },
}));

vi.mock('@supabase/auth-js', () => ({
  AuthClient: class {
    getSession() {
      return Promise.resolve({
        data: { session: session.token === null ? null : { access_token: session.token } },
      });
    }
  },
}));

const { supabase } = await import('./client.ts');

const calls: { url: string; headers: Headers }[] = [];

beforeEach(() => {
  calls.length = 0;
  session.token = null;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sent(): { url: string; headers: Headers } {
  const call = calls[0];
  if (call === undefined) throw new Error('nothing was sent');
  return call;
}

describe('a data request', () => {
  it('goes to the project, with no doubled slash from a trailing one in the env', async () => {
    await supabase.from('things').select('id');
    expect(sent().url).toMatch(/^https:\/\/example\.supabase\.co\/rest\/v1\/things\?/);
  });

  it('carries the key as both headers when nobody is signed in', async () => {
    await supabase.from('things').select('id');
    expect(sent().headers.get('apikey')).toBe(KEY);
    expect(sent().headers.get('Authorization')).toBe(`Bearer ${KEY}`);
  });

  it("carries the user's token as the bearer once signed in, and the key as apikey", async () => {
    session.token = 'user-jwt';
    await supabase.from('things').select('id');
    expect(sent().headers.get('apikey')).toBe(KEY);
    expect(sent().headers.get('Authorization')).toBe('Bearer user-jwt');
  });

  it('reads the token on every request, so a refreshed one is used at once', async () => {
    session.token = 'first';
    await supabase.from('things').select('id');
    session.token = 'rotated';
    await supabase.from('things').select('id');
    expect(calls.map((c) => c.headers.get('Authorization'))).toEqual([
      'Bearer first',
      'Bearer rotated',
    ]);
  });

  it('sends an rpc through the same headers', async () => {
    session.token = 'user-jwt';
    await supabase.rpc('schema_version');
    expect(sent().url).toBe('https://example.supabase.co/rest/v1/rpc/schema_version');
    expect(sent().headers.get('Authorization')).toBe('Bearer user-jwt');
  });
});
