import { describe, expect, it } from 'vitest';

import { relink } from './relink.ts';

const OWNER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-26T12:00:00Z');
const HOSTED = 'https://secure.plaid.com/hl/abc';

const ENV = {
  SUPABASE_URL: 'https://db.test/',
  SUPABASE_SECRET_KEY: 'sb_secret_x',
  PLAID_CLIENT_ID: 'a'.repeat(24),
  PLAID_SECRET: 'b'.repeat(30),
  PLAID_ACCESS_TOKENS: 'access-production-1 access-production-2',
};

const LOGIN = { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' };

type Call = { readonly url: string; readonly body: unknown; readonly headers: Headers };

type World = {
  readonly user?: string | null;
  readonly users?: readonly string[];
  /** Each item's `/item/get` answer, by access token. */
  readonly items?: (token: string) => Response;
  readonly created?: () => Response;
};

function world(w: World = {}) {
  const calls: Call[] = [];
  const fake: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    const token =
      typeof body === 'object' && body !== null && 'access_token' in body
        ? String(body.access_token)
        : '';
    if (url === 'https://db.test/auth/v1/user') {
      const user = w.user === undefined ? OWNER : w.user;
      return Promise.resolve(
        user === null ? new Response('{}', { status: 401 }) : Response.json({ id: user }),
      );
    }
    if (url.startsWith('https://db.test/auth/v1/admin/users')) {
      return Promise.resolve(Response.json({ users: (w.users ?? [OWNER]).map((id) => ({ id })) }));
    }
    if (url === 'https://production.plaid.com/item/get') {
      const items =
        w.items ??
        ((t: string) =>
          Response.json({
            item:
              t === 'access-production-2'
                ? { institution_name: 'Harbor Mortgage', error: LOGIN }
                : { institution_name: 'Lakeside Bank', error: null },
          }));
      return Promise.resolve(items(token));
    }
    if (url === 'https://production.plaid.com/link/token/create') {
      return Promise.resolve(
        w.created?.() ?? Response.json({ link_token: 'link-x', hosted_link_url: HOSTED }),
      );
    }
    if (url === 'https://production.plaid.com/accounts/get') {
      return Promise.resolve(Response.json({ accounts: [] }));
    }
    if (url === 'https://db.test/rest/v1/rpc/bank_store') {
      return Promise.resolve(
        Response.json({
          requests: 4,
          accounts: 0,
          transactions: 0,
          added: 0,
          dropped: 0,
          restored: 0,
          kept: 0,
          rebuilt: 0,
          drops_from: null,
        }),
      );
    }
    if (url === 'https://db.test/rest/v1/bank_pulls') {
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    return Promise.resolve(new Response('unrouted', { status: 599 }));
  };
  return { fetch: fake, calls };
}

function asked(step: unknown, bearer: string | null = 'user-jwt'): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (bearer !== null) headers.set('Authorization', `Bearer ${bearer}`);
  return new Request('https://dinora.test/api/plaid/relink', {
    method: 'POST',
    headers,
    body: JSON.stringify({ step }),
  });
}

describe('relink', () => {
  it('answers with Hosted Link for the item Plaid says wants signing in, naming its bank', async () => {
    const w = world();
    expect(await relink(asked('start'), ENV, w.fetch, NOW)).toEqual({
      status: 200,
      answer: { kind: 'open', bank: 'Harbor Mortgage', url: HOSTED },
    });
    const created = w.calls.find((c) => c.url.endsWith('/link/token/create'));
    expect(created?.body).toMatchObject({
      access_token: 'access-production-2',
      hosted_link: {},
      user: { client_user_id: 'owner' },
    });
    expect(created?.body).not.toHaveProperty('products');
  });

  it('asks auth about the session the request carries, not the service key', async () => {
    const w = world();
    await relink(asked('start'), ENV, w.fetch, NOW);
    const user = w.calls.find((c) => c.url === 'https://db.test/auth/v1/user');
    expect(user?.headers.get('authorization')).toBe('Bearer user-jwt');
    expect(user?.headers.get('apikey')).toBe('sb_secret_x');
  });

  it('never answers with an access token', async () => {
    const { answer } = await relink(asked('start'), ENV, world().fetch, NOW);
    expect(JSON.stringify(answer)).not.toContain('access-production');
  });

  it('says so when Plaid has no bank that wants signing in', async () => {
    const w = world({ items: () => Response.json({ item: { institution_name: 'X' } }) });
    expect(await relink(asked('start'), ENV, w.fetch, NOW)).toEqual({
      status: 200,
      answer: { kind: 'none' },
    });
    expect(w.calls.some((c) => c.url.endsWith('/link/token/create'))).toBe(false);
  });

  it('names a bank with no name by its place', async () => {
    const w = world({ items: () => Response.json({ item: { error: LOGIN } }) });
    const { answer } = await relink(asked('start'), ENV, w.fetch, NOW);
    expect(answer).toMatchObject({ kind: 'open', bank: "item 1's bank" });
  });

  it('refuses when Plaid will not answer for an item, or makes no address', async () => {
    const down = world({ items: () => new Response('{}', { status: 500 }) });
    expect(await relink(asked('start'), ENV, down.fetch, NOW)).toMatchObject({
      status: 502,
      answer: { kind: 'refused', reason: expect.stringMatching(/^item 1: /) },
    });
    const bare = world({ created: () => Response.json({ link_token: 'link-x' }) });
    expect(await relink(asked('start'), ENV, bare.fetch, NOW)).toEqual({
      status: 502,
      answer: { kind: 'refused', reason: 'Plaid made no Hosted Link address' },
    });
  });

  it('reads Plaid there and then, and stores it as a plaid pull', async () => {
    const w = world();
    expect(await relink(asked('read'), ENV, w.fetch, NOW)).toEqual({
      status: 200,
      answer: { kind: 'read' },
    });
    expect(w.calls.some((c) => c.url.endsWith('/rpc/bank_store'))).toBe(true);
  });

  it('says why a read failed, in the words the home screen uses', async () => {
    const login = world({
      items: (t) =>
        Response.json({
          item: {
            institution_name: t === 'access-production-2' ? 'Harbor Mortgage' : 'Lakeside Bank',
          },
        }),
    });
    const refusing: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url.endsWith('/accounts/get')
        ? Promise.resolve(Response.json(LOGIN, { status: 400 }))
        : login.fetch(input, init);
    };
    expect(await relink(asked('read'), ENV, refusing, NOW)).toEqual({
      status: 200,
      answer: {
        kind: 'failed',
        reason: 'Lakeside Bank needs signing in again; Harbor Mortgage needs signing in again',
      },
    });
  });

  it('refuses a request with no session, or one auth does not know', async () => {
    const none = world();
    expect(await relink(asked('start', null), ENV, none.fetch, NOW)).toEqual({
      status: 401,
      answer: { kind: 'refused', reason: 'not signed in' },
    });
    expect(none.calls).toHaveLength(0);
    const unknown = world({ user: null });
    expect((await relink(asked('start'), ENV, unknown.fetch, NOW)).status).toBe(401);
    expect(unknown.calls.some((c) => c.url.includes('plaid.com'))).toBe(false);
  });

  it('refuses anyone but the one person the banks are read for', async () => {
    const other = world({ user: '22222222-2222-2222-2222-222222222222' });
    expect(await relink(asked('start'), ENV, other.fetch, NOW)).toEqual({
      status: 403,
      answer: { kind: 'refused', reason: 'not the owner of these banks' },
    });
    expect(other.calls.some((c) => c.url.includes('plaid.com'))).toBe(false);
    const two = world({ users: [OWNER, '22222222-2222-2222-2222-222222222222'] });
    expect((await relink(asked('start'), ENV, two.fetch, NOW)).status).toBe(503);
  });

  it('refuses a step it does not know, and a function not configured', async () => {
    expect((await relink(asked('link'), ENV, world().fetch, NOW)).status).toBe(400);
    const unset = await relink(
      asked('start'),
      { ...ENV, PLAID_ACCESS_TOKENS: ' ' },
      world().fetch,
      NOW,
    );
    expect(unset).toEqual({
      status: 503,
      answer: { kind: 'refused', reason: 'not configured: PLAID_ACCESS_TOKENS' },
    });
  });

  it("refuses keys that are not Plaid's form before asking Plaid anything", async () => {
    const w = world();
    const got = await relink(asked('start'), { ...ENV, PLAID_SECRET: 'x' }, w.fetch, NOW);
    expect(got.status).toBe(503);
    expect(w.calls.some((c) => c.url.includes('plaid.com'))).toBe(false);
  });
});
