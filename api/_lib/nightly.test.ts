import { describe, expect, it } from 'vitest';

import { nightly, plaidNightly } from './nightly.ts';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-24T09:00:00.000Z');
const ENV = {
  SIMPLEFIN_ACCESS_URL: 'https://u:p@bridge.test/simplefin',
  SUPABASE_URL: 'https://db.test/',
  SUPABASE_SECRET_KEY: 'sb_secret_x',
};

const BRIDGE = {
  errlist: [],
  connections: [{ conn_id: 'C', name: 'Bank' }],
  accounts: [
    {
      id: 'A',
      name: 'Card',
      conn_id: 'C',
      currency: 'USD',
      balance: '-10.00',
      'balance-date': 1_000,
      transactions: [{ id: 't1', posted: 900, amount: '-1.00', description: 'x' }],
    },
  ],
};

const STORED = {
  requests: 2,
  accounts: 1,
  transactions: 1,
  added: 1,
  dropped: 0,
  restored: 0,
  kept: 1,
  rebuilt: 30,
  drops_from: '2026-07-26T09:00:00.000Z',
};

type Call = { url: string; method: string; body: unknown; headers: Headers };

/** A stand-in for the Bridge and Supabase, routed by host and path. */
function world(overrides: { users?: unknown; bridge?: unknown; store?: Response } = {}) {
  const calls: Call[] = [];
  const route = (url: string): Response => {
    if (url.startsWith('https://db.test/auth/v1/admin/users')) {
      return Response.json(overrides.users ?? { users: [{ id: USER }] });
    }
    if (url.startsWith('https://bridge.test/')) {
      const b = overrides.bridge ?? BRIDGE;
      return b instanceof Response ? b.clone() : Response.json(b);
    }
    if (url === 'https://db.test/rest/v1/rpc/bank_store') {
      return overrides.store ?? Response.json(STORED);
    }
    if (url === 'https://db.test/rest/v1/bank_pulls') return new Response(null, { status: 201 });
    return new Response('unrouted', { status: 599 });
  };
  const fake: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) });
    return Promise.resolve(route(url));
  };
  return { fetch: fake, calls };
}

describe('nightly', () => {
  it('reads 90 days in two requests and stores them through bank_store', async () => {
    const w = world();
    const outcome = await nightly(ENV, w.fetch, NOW);

    expect(outcome).toEqual({
      ok: true,
      requests: 2,
      accounts: 1,
      transactions: 1,
      added: 1,
      dropped: 0,
      restored: 0,
      kept: 1,
      rebuilt: 30,
      markedDrops: true,
    });
    expect(w.calls.filter((c) => c.url.startsWith('https://bridge.test/'))).toHaveLength(2);
    const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
    expect(store?.headers.get('apikey')).toBe('sb_secret_x');
    expect(store?.body).toMatchObject({
      p_user: USER,
      p_source: 'simplefin',
      p_started_at: NOW.toISOString(),
      p_requests: 2,
      p_drops_from: '2026-07-26T09:00:00.000Z',
      p_detail: '',
    });
    expect(store?.body).toHaveProperty('p_payload.transactions.0.source_id', 't1');
  });

  it('does not look for drops when the Bridge complained', async () => {
    const w = world({ bridge: { ...BRIDGE, errlist: [{ code: 'gen.auth', msg: 're-link' }] } });
    await nightly(ENV, w.fetch, NOW);
    const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
    expect(store?.body).toMatchObject({ p_drops_from: null, p_detail: 'gen.auth: re-link' });
  });

  it('names what is not configured, and touches nothing', async () => {
    const w = world();
    const outcome = await nightly({ SUPABASE_URL: 'https://db.test' }, w.fetch, NOW);
    expect(outcome).toEqual({
      ok: false,
      reason: 'not configured: SIMPLEFIN_ACCESS_URL, SUPABASE_SECRET_KEY',
      recorded: false,
    });
    expect(w.calls).toHaveLength(0);
  });

  it.each([
    [{ users: [] }, 'none'],
    [{ users: [{ id: USER }, { id: '22222222-2222-2222-2222-222222222222' }] }, 'more'],
  ])('refuses to guess whose banks these are: %#', async (users, found) => {
    const w = world({ users });
    const outcome = await nightly(ENV, w.fetch, NOW);
    expect(outcome).toEqual({
      ok: false,
      reason: `expected exactly one user, found ${found}`,
      recorded: false,
    });
    expect(w.calls.some((c) => c.url.startsWith('https://bridge.test/'))).toBe(false);
  });

  it('records a Bridge failure as a failed run, and stores nothing', async () => {
    const w = world({ bridge: new Response('', { status: 403 }) });
    const outcome = await nightly(ENV, w.fetch, NOW);
    expect(outcome).toMatchObject({ ok: false, recorded: true });
    expect(w.calls.some((c) => c.url.endsWith('/rpc/bank_store'))).toBe(false);
    const record = w.calls.find((c) => c.url.endsWith('/rest/v1/bank_pulls'));
    expect(record?.body).toMatchObject({
      user_id: USER,
      outcome: 'failed',
      // The windows are asked in turn, so the older is never asked after the newest fails.
      requests: 1,
      detail: 'the Bridge refused the access URL (403); it may have been revoked',
    });
  });

  it('records a failed store', async () => {
    const w = world({ store: new Response('', { status: 500 }) });
    const outcome = await nightly(ENV, w.fetch, NOW);
    expect(outcome).toEqual({
      ok: false,
      reason: 'storing answered HTTP 500',
      recorded: true,
    });
  });

  it('does not contradict a store that committed but answered oddly', async () => {
    const w = world({ store: Response.json({ unexpected: true }) });
    const outcome = await nightly(ENV, w.fetch, NOW);
    expect(outcome).toMatchObject({ ok: false, recorded: true });
    expect(w.calls.some((c) => c.url.endsWith('/rest/v1/bank_pulls'))).toBe(false);
  });

  it('records a malformed access URL without spending a request', async () => {
    const w = world();
    const outcome = await nightly({ ...ENV, SIMPLEFIN_ACCESS_URL: 'http://nope' }, w.fetch, NOW);
    expect(outcome).toMatchObject({ ok: false, recorded: true });
    expect(w.calls.some((c) => c.url.startsWith('https://bridge.test/'))).toBe(false);
  });

  it('never carries an amount or a payee in what it answers', async () => {
    const outcome = await nightly(ENV, world().fetch, NOW);
    expect(JSON.stringify(outcome)).not.toMatch(/-1\.00|-100|10\.00|Card|Bank/);
  });
});

describe('plaidNightly', () => {
  const PLAID_ENV = {
    SUPABASE_URL: 'https://db.test',
    SUPABASE_SECRET_KEY: 'sb_secret_x',
    PLAID_CLIENT_ID: 'a'.repeat(24),
    PLAID_SECRET: 'b'.repeat(30),
    PLAID_ACCESS_TOKENS: 'access-production-1  access-production-2\n',
  };

  function ok(): Response {
    return Response.json({
      accounts: [
        {
          account_id: 'm',
          name: 'Mortgage',
          type: 'loan',
          subtype: 'mortgage',
          balances: { current: 1000.25, available: null, iso_currency_code: 'USD' },
        },
      ],
    });
  }

  type More = {
    readonly item?: (token: string) => unknown;
    readonly sync?: (token: string) => Response;
    readonly cursors?: () => Response;
  };

  function plaidWorld(accounts: (token: string) => Response = () => ok(), more: More = {}) {
    const calls: Call[] = [];
    const fake: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) });
      const token =
        typeof body === 'object' && body !== null && 'access_token' in body
          ? String(body.access_token)
          : '';
      if (url.startsWith('https://db.test/auth/v1/admin/users')) {
        return Promise.resolve(Response.json({ users: [{ id: USER }] }));
      }
      if (url === 'https://production.plaid.com/item/get') {
        const item = more.item?.(token) ?? { item: { institution_name: 'Harbor Mortgage' } };
        return Promise.resolve(Response.json(item));
      }
      if (url === 'https://production.plaid.com/transactions/sync' && more.sync !== undefined) {
        return Promise.resolve(more.sync(token));
      }
      if (url.startsWith('https://db.test/rest/v1/bank_cursors?')) {
        return Promise.resolve(more.cursors?.() ?? Response.json([]));
      }
      if (url === 'https://production.plaid.com/accounts/get') {
        return Promise.resolve(accounts(token));
      }
      if (url === 'https://db.test/rest/v1/rpc/bank_store') {
        return Promise.resolve(Response.json({ ...STORED, requests: 4, rebuilt: 0 }));
      }
      if (url === 'https://db.test/rest/v1/bank_pulls') {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      return Promise.resolve(new Response('unrouted', { status: 599 }));
    };
    return { fetch: fake, calls };
  }

  it("reads every item in production and stores them as plaid, in the cardholder's sign", async () => {
    const w = plaidWorld();
    const outcome = await plaidNightly(PLAID_ENV, w.fetch, NOW);
    expect(outcome).toMatchObject({ ok: true, requests: 4, rebuilt: 0 });

    const plaid = w.calls.filter((c) => c.url.startsWith('https://production.plaid.com/'));
    expect(plaid).toHaveLength(4);
    const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
    expect(store?.body).toMatchObject({
      p_source: 'plaid',
      p_requests: 4,
      p_drops_from: null,
      p_payload: {
        history_from: null,
        transactions: [],
        accounts: [
          {
            source_id: 'm',
            institution: 'Harbor Mortgage',
            balance_minor: -100025,
            balance_at: NOW.toISOString(),
          },
          { source_id: 'm' },
        ],
      },
    });
  });

  it('records a refusal as a failed plaid pull, naming the item by place only', async () => {
    const w = plaidWorld((token) =>
      token === 'access-production-2'
        ? Response.json(
            { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: 'x' },
            { status: 500 },
          )
        : Response.json({ accounts: [] }),
    );
    const outcome = await plaidNightly(PLAID_ENV, w.fetch, NOW);
    const reason = 'item 2: Plaid refused /accounts/get: HTTP 500, API_ERROR/INTERNAL_SERVER_ERROR';
    expect(outcome).toEqual({ ok: false, reason, recorded: true });
    const recorded = w.calls.find((c) => c.url.endsWith('/rest/v1/bank_pulls'));
    expect(recorded?.body).toMatchObject({ source: 'plaid', outcome: 'failed', requests: 4 });
    expect(w.calls.some((c) => c.url.endsWith('/rpc/bank_store'))).toBe(false);
  });

  const login = () =>
    Response.json(
      { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'x' },
      { status: 400 },
    );

  it('stores the other banks and names the one that wants signing in again (BANK-10)', async () => {
    const w = plaidWorld((token) => (token === 'access-production-2' ? login() : ok()));
    const outcome = await plaidNightly(PLAID_ENV, w.fetch, NOW);
    expect(outcome).toMatchObject({ ok: true });
    const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
    expect(store?.body).toMatchObject({
      p_payload: { accounts: [{ source_id: 'm' }] },
      p_detail: 'Harbor Mortgage needs signing in again',
    });
    expect(w.calls.some((c) => c.url.endsWith('/rest/v1/bank_pulls'))).toBe(false);
  });

  it('fails, naming the bank, when every bank wants signing in again (UI-09)', async () => {
    const w = plaidWorld(login);
    const outcome = await plaidNightly(
      { ...PLAID_ENV, PLAID_ACCESS_TOKENS: 'access-production-1' },
      w.fetch,
      NOW,
    );
    const reason = 'Harbor Mortgage needs signing in again';
    expect(outcome).toEqual({ ok: false, reason, recorded: true });
    expect(w.calls.some((c) => c.url.endsWith('/rpc/bank_store'))).toBe(false);
  });

  it('fails an answer that does not parse, and stores nothing', async () => {
    const w = plaidWorld(() => Response.json({ nothing: true }));
    expect(await plaidNightly(PLAID_ENV, w.fetch, NOW)).toEqual({
      ok: false,
      reason: "item 1's answer did not parse",
      recorded: true,
    });
  });

  it("says what is not configured, and refuses keys not in Plaid's form", async () => {
    const w = plaidWorld();
    expect(await plaidNightly({ ...PLAID_ENV, PLAID_ACCESS_TOKENS: ' ' }, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'not configured: PLAID_ACCESS_TOKENS',
      recorded: false,
    });
    expect(await plaidNightly({ ...PLAID_ENV, PLAID_SECRET: 'x' }, w.fetch, NOW)).toMatchObject({
      ok: false,
      reason: "PLAID_CLIENT_ID, PLAID_SECRET or PLAID_ENV is not Plaid's form",
    });
    expect(
      await plaidNightly({ ...PLAID_ENV, PLAID_ENV: 'development' }, w.fetch, NOW),
    ).toMatchObject({
      ok: false,
    });
  });

  describe('new transactions (BANK-14)', () => {
    const CARD = 'access-production-2';
    const item = (token: string) =>
      token === CARD
        ? {
            item: {
              item_id: 'gemini-item',
              institution_name: 'Gemini',
              products: ['transactions'],
            },
          }
        : {
            item: {
              item_id: 'harbor-item',
              institution_name: 'Harbor Mortgage',
              products: ['liabilities'],
            },
          };
    const card = () =>
      Response.json({
        accounts: [
          {
            account_id: 'card',
            name: 'Gemini Credit Card',
            type: 'credit',
            subtype: 'credit card',
            balances: { current: 50, available: null, iso_currency_code: 'USD' },
          },
        ],
      });
    const synced = () =>
      Response.json({
        added: [
          {
            transaction_id: 'posted',
            account_id: 'card',
            amount: 12.34,
            iso_currency_code: 'USD',
            date: '2026-09-27',
            name: 'COFFEE',
            pending: false,
          },
        ],
        modified: [],
        removed: [{ transaction_id: 'was-pending' }],
        next_cursor: 'next',
        has_more: false,
      });

    it('syncs only the item that reads transactions, from its cursor, and stores it all at once', async () => {
      const w = plaidWorld((token) => (token === CARD ? card() : ok()), {
        item,
        sync: synced,
        cursors: () => Response.json([{ item: 'gemini-item', cursor: 'held' }]),
      });
      const outcome = await plaidNightly(PLAID_ENV, w.fetch, NOW);
      expect(outcome).toMatchObject({ ok: true });

      const syncs = w.calls.filter((c) => c.url.endsWith('/transactions/sync'));
      expect(syncs.map((c) => c.body)).toEqual([
        expect.objectContaining({ access_token: CARD, cursor: 'held', count: 500 }),
      ]);
      const cursors = w.calls.find((c) => c.url.includes('/rest/v1/bank_cursors?'));
      expect(cursors?.url).toContain(`user_id=eq.${USER}`);
      expect(cursors?.url).toContain('source=eq.plaid');

      const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
      expect(store?.body).toMatchObject({
        p_requests: 5,
        p_drops_from: null,
        p_payload: {
          history_from: null,
          transactions: [{ source_id: 'posted', account_source_id: 'card', amount_minor: -1234 }],
          removed: ['was-pending'],
          cursors: [{ item: 'gemini-item', cursor: 'next' }],
        },
      });
    });

    it('keeps the balances when a sync fails, names the bank, and moves no cursor', async () => {
      const refused = () =>
        Response.json(
          { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: 'x' },
          { status: 500 },
        );
      const w = plaidWorld((token) => (token === CARD ? card() : ok()), { item, sync: refused });
      const outcome = await plaidNightly(PLAID_ENV, w.fetch, NOW);
      expect(outcome).toMatchObject({ ok: true });
      const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
      expect(store?.body).toMatchObject({
        p_payload: { accounts: [{ source_id: 'm' }, { source_id: 'card' }], cursors: [] },
        p_detail:
          "Gemini's transactions were not read: Plaid refused /transactions/sync: HTTP 500, " +
          'API_ERROR/INTERNAL_SERVER_ERROR',
      });
    });

    it('says a bank wants signing in when only its sync is refused for it', async () => {
      const login = () =>
        Response.json(
          { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' },
          { status: 400 },
        );
      const w = plaidWorld((token) => (token === CARD ? card() : ok()), { item, sync: login });
      await plaidNightly(PLAID_ENV, w.fetch, NOW);
      const store = w.calls.find((c) => c.url.endsWith('/rpc/bank_store'));
      expect(store?.body).toMatchObject({ p_detail: 'Gemini needs signing in again' });
    });

    it('fails the night when it cannot read where each sync got to, rather than start over', async () => {
      const w = plaidWorld((token) => (token === CARD ? card() : ok()), {
        item,
        sync: synced,
        cursors: () => new Response('', { status: 500 }),
      });
      expect(await plaidNightly(PLAID_ENV, w.fetch, NOW)).toEqual({
        ok: false,
        reason: 'reading where each sync got to failed',
        recorded: true,
      });
      expect(w.calls.some((c) => c.url.endsWith('/transactions/sync'))).toBe(false);
    });

    it('never carries an amount or a payee in what it answers', async () => {
      const w = plaidWorld((token) => (token === CARD ? card() : ok()), { item, sync: synced });
      const outcome = await plaidNightly(PLAID_ENV, w.fetch, NOW);
      expect(JSON.stringify(outcome)).not.toMatch(/12\.34|1234|COFFEE|Gemini/);
    });
  });

  it('reads sandbox when told to', async () => {
    const w = plaidWorld();
    await plaidNightly({ ...PLAID_ENV, PLAID_ENV: 'sandbox' }, w.fetch, NOW);
    expect(w.calls.some((c) => c.url.startsWith('https://sandbox.plaid.com/'))).toBe(true);
  });
});
