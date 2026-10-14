import { describe, expect, it } from 'vitest';

import { readAgain } from './read.ts';

const OWNER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-28T11:00:00Z');

const ENV = {
  SIMPLEFIN_ACCESS_URL: 'https://u:p@bridge.test/simplefin',
  SUPABASE_URL: 'https://db.test/',
  SUPABASE_SECRET_KEY: 'sb_secret_x',
  PLAID_CLIENT_ID: 'a'.repeat(24),
  PLAID_SECRET: 'b'.repeat(30),
  PLAID_ACCESS_TOKENS: 'access-production-1',
};

const BRIDGE = {
  errlist: [],
  connections: [{ conn_id: 'C', name: 'SUMMIT' }],
  accounts: [
    {
      id: 'A',
      name: 'Savings',
      conn_id: 'C',
      currency: 'USD',
      balance: '1.00',
      'balance-date': 1_700_000_000,
      transactions: [],
    },
  ],
};

const STORED = {
  requests: 2,
  accounts: 1,
  transactions: 0,
  added: 0,
  dropped: 0,
  restored: 0,
  kept: 1,
  rebuilt: 0,
  drops_from: null,
};

type Call = { readonly url: string; readonly body: unknown; readonly headers: Headers };

type World = {
  readonly user?: string | null;
  readonly users?: readonly string[];
  readonly bridge?: () => Response;
};

function world(w: World = {}) {
  const calls: Call[] = [];
  const fake: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    const answer = (): Response => {
      if (url === 'https://db.test/auth/v1/user') {
        const user = w.user === undefined ? OWNER : w.user;
        return user === null ? new Response('{}', { status: 401 }) : Response.json({ id: user });
      }
      if (url.startsWith('https://db.test/auth/v1/admin/users')) {
        return Response.json({ users: (w.users ?? [OWNER]).map((id) => ({ id })) });
      }
      if (url.startsWith('https://bridge.test/')) return w.bridge?.() ?? Response.json(BRIDGE);
      if (url === 'https://production.plaid.com/item/get') {
        return Response.json({ item: { institution_name: 'Harbor Mortgage', error: null } });
      }
      if (url === 'https://production.plaid.com/accounts/get') {
        return Response.json({ accounts: [] });
      }
      if (url === 'https://db.test/rest/v1/rpc/bank_store') return Response.json(STORED);
      if (url === 'https://db.test/rest/v1/bank_pulls') return new Response(null, { status: 201 });
      return new Response('unrouted', { status: 599 });
    };
    return Promise.resolve(answer());
  };
  return { fetch: fake, calls };
}

function asked(body: unknown, bearer: string | null = 'user-jwt'): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (bearer !== null) headers.set('Authorization', `Bearer ${bearer}`);
  return new Request('https://dinora.test/api/bank/read', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('readAgain', () => {
  it("reads SimpleFIN there and then, and stores it as a night's simplefin pull", async () => {
    const w = world();
    expect(await readAgain(asked({ source: 'simplefin' }), ENV, w.fetch, NOW)).toEqual({
      status: 200,
      answer: { kind: 'read' },
    });
    expect(w.calls.filter((c) => c.url.startsWith('https://bridge.test/'))).toHaveLength(2);
    const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
    expect(store?.body).toMatchObject({ p_source: 'simplefin', p_started_at: NOW.toISOString() });
    expect(w.calls.some((c) => c.url.includes('plaid.com'))).toBe(false);
  });

  it('reads Plaid when asked for it, and stores it as a plaid pull', async () => {
    const w = world();
    expect(await readAgain(asked({ source: 'plaid' }), ENV, w.fetch, NOW)).toEqual({
      status: 200,
      answer: { kind: 'read' },
    });
    const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
    expect(store?.body).toMatchObject({ p_source: 'plaid' });
    expect(w.calls.some((c) => c.url.startsWith('https://bridge.test/'))).toBe(false);
  });

  it("says why a read failed, in the words the home screen shows for a night's", async () => {
    const w = world({ bridge: () => new Response('<h1>Server Error</h1>', { status: 500 }) });
    const got = await readAgain(asked({ source: 'simplefin' }), ENV, w.fetch, NOW);
    expect(got).toEqual({
      status: 200,
      answer: { kind: 'failed', reason: 'the Bridge answered HTTP 500: "Server Error"' },
    });
    // Recorded as the failed pull it was, so the home screen says so too.
    expect(w.calls.some((c) => c.url.endsWith('/rest/v1/bank_pulls'))).toBe(true);
  });

  it('asks auth about the session the request carries, not the service key', async () => {
    const w = world();
    await readAgain(asked({ source: 'simplefin' }), ENV, w.fetch, NOW);
    const user = w.calls.find((c) => c.url === 'https://db.test/auth/v1/user');
    expect(user?.headers.get('authorization')).toBe('Bearer user-jwt');
    expect(user?.headers.get('apikey')).toBe('sb_secret_x');
  });

  it('never answers with a credential', async () => {
    const w = world({ bridge: () => new Response('down', { status: 502 }) });
    const { answer } = await readAgain(asked({ source: 'simplefin' }), ENV, w.fetch, NOW);
    const words = JSON.stringify(answer);
    expect(words).not.toContain('u:p');
    expect(words).not.toContain('sb_secret');
  });

  it('refuses a request with no session, or one auth does not know', async () => {
    const none = world();
    expect(await readAgain(asked({ source: 'simplefin' }, null), ENV, none.fetch, NOW)).toEqual({
      status: 401,
      answer: { kind: 'refused', reason: 'not signed in' },
    });
    expect(none.calls).toHaveLength(0);
    const unknown = world({ user: null });
    expect((await readAgain(asked({ source: 'simplefin' }), ENV, unknown.fetch, NOW)).status).toBe(
      401,
    );
    expect(unknown.calls.some((c) => c.url.startsWith('https://bridge.test/'))).toBe(false);
  });

  it('refuses anyone but the one person the banks are read for', async () => {
    const other = world({ user: '22222222-2222-2222-2222-222222222222' });
    expect(await readAgain(asked({ source: 'simplefin' }), ENV, other.fetch, NOW)).toEqual({
      status: 403,
      answer: { kind: 'refused', reason: 'not the owner of these banks' },
    });
    expect(other.calls.some((c) => c.url.startsWith('https://bridge.test/'))).toBe(false);
  });

  it('refuses a source it does not know', async () => {
    const w = world();
    expect(await readAgain(asked({ source: 'monarch' }), ENV, w.fetch, NOW)).toEqual({
      status: 400,
      answer: { kind: 'refused', reason: 'expected a source: simplefin or plaid' },
    });
    expect((await readAgain(asked('simplefin'), ENV, w.fetch, NOW)).status).toBe(400);
  });

  it('refuses a source that is not configured, before asking it anything', async () => {
    const w = world();
    const got = await readAgain(
      asked({ source: 'plaid' }),
      { ...ENV, PLAID_ACCESS_TOKENS: ' ' },
      w.fetch,
      NOW,
    );
    expect(got).toEqual({
      status: 503,
      answer: { kind: 'refused', reason: 'not configured: PLAID_ACCESS_TOKENS' },
    });
    expect(w.calls.some((c) => c.url.includes('plaid.com'))).toBe(false);
    const noDb = await readAgain(asked({ source: 'simplefin' }), {}, w.fetch, NOW);
    expect(noDb).toEqual({
      status: 503,
      answer: { kind: 'refused', reason: 'not configured: SUPABASE_URL, SUPABASE_SECRET_KEY' },
    });
  });
});
