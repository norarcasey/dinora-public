import { describe, expect, it } from 'vitest';

import { call, plaidEnv, pullItems, syncItem, wellFormed } from './plaid.ts';

const keys = { clientId: 'id', secret: 'shh', env: 'sandbox' } as const;

function answering(status: number, body: string): typeof fetch {
  return () => Promise.resolve(new Response(body, { status }));
}

describe('plaidEnv', () => {
  it('knows sandbox and production and nothing else', () => {
    expect(plaidEnv('sandbox')).toBe('sandbox');
    expect(plaidEnv('production')).toBe('production');
    expect(plaidEnv('development')).toBeNull();
  });
});

describe('wellFormed', () => {
  it("takes Plaid's form and refuses a paste that carried something with it", () => {
    const id = 'a'.repeat(24);
    const secret = '0'.repeat(30);
    expect(wellFormed(id, secret)).toBe(true);
    expect(wellFormed(`${id}\\`, secret)).toBe(false);
    expect(wellFormed(id, `${secret}\\`)).toBe(false);
    expect(wellFormed(id.toUpperCase(), secret)).toBe(false);
  });
});

describe('call', () => {
  it('posts the keys in the body to the environment named', async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetcher: typeof fetch = (input, init) => {
      seen = {
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      return Promise.resolve(new Response('{"ok":1}', { status: 200 }));
    };
    expect(await call(keys, '/accounts/get', { access_token: 't' }, fetcher)).toEqual({
      ok: true,
      body: { ok: 1 },
    });
    expect(seen).toEqual({
      url: 'https://sandbox.plaid.com/accounts/get',
      body: { client_id: 'id', secret: 'shh', access_token: 't' },
    });
  });

  it("names Plaid's error by its codes, never its message", async () => {
    const error = JSON.stringify({
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'the account Checking 1234 needs attention',
    });
    const called = await call(keys, '/accounts/get', {}, answering(400, error));
    expect(called).toEqual({
      ok: false,
      reason: 'Plaid refused /accounts/get: HTTP 400, ITEM_ERROR/ITEM_LOGIN_REQUIRED',
      code: 'ITEM_LOGIN_REQUIRED',
    });
  });

  it('says so when the answer is not JSON, or there is none', async () => {
    expect(await call(keys, '/x', {}, answering(502, '<html>'))).toEqual({
      ok: false,
      reason: 'Plaid answered /x with HTTP 502, not JSON',
      code: null,
    });
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await call(keys, '/x', {}, down)).toEqual({
      ok: false,
      reason: 'Plaid did not answer /x (TypeError)',
      code: null,
    });
  });

  it('keeps a refusal without codes a refusal', async () => {
    expect(await call(keys, '/x', {}, answering(500, '{}'))).toEqual({
      ok: false,
      reason: 'Plaid refused /x: HTTP 500, no error code',
      code: null,
    });
  });
});

describe('pullItems', () => {
  const login = { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' };
  const names: Record<string, string> = { g: 'Harbor Mortgage', c: 'Lakeside Bank' };

  /** Each token's `/accounts/get` answer; `/item/get` names the bank by its token. */
  function plaid(accounts: Record<string, { status: number; body: unknown }>): typeof fetch {
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const sent: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const token =
        typeof sent === 'object' && sent !== null && 'access_token' in sent
          ? String(sent.access_token)
          : '';
      const answer = url.endsWith('/item/get')
        ? { status: 200, body: { item: { institution_name: names[token] ?? null } } }
        : (accounts[token] ?? { status: 500, body: {} });
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    };
  }

  it('reads the other banks and names the one that wants signing in again (BANK-10)', async () => {
    const got = await pullItems(
      keys,
      ['g', 'c'],
      plaid({
        g: { status: 400, body: login },
        c: { status: 200, body: { accounts: [] } },
      }),
    );
    expect(got).toEqual({
      ok: true,
      items: [
        {
          place: 1,
          item: { item: { institution_name: 'Lakeside Bank' } },
          accounts: { accounts: [] },
        },
      ],
      warnings: ['Harbor Mortgage needs signing in again'],
      requests: 4,
    });
  });

  it('fails when every bank wants signing in, since there is nothing to read', async () => {
    expect(
      await pullItems(
        keys,
        ['g', 'x'],
        plaid({ g: { status: 400, body: login }, x: { status: 400, body: login } }),
      ),
    ).toEqual({
      ok: false,
      reason: "Harbor Mortgage needs signing in again; item 2's bank needs signing in again",
      requests: 4,
    });
  });

  it('still fails the night on any other refusal, named by the item and its codes', async () => {
    const other = { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' };
    expect(
      await pullItems(
        keys,
        ['g', 'c'],
        plaid({
          g: { status: 400, body: login },
          c: { status: 500, body: other },
        }),
      ),
    ).toEqual({
      ok: false,
      reason: 'item 2: Plaid refused /accounts/get: HTTP 500, API_ERROR/INTERNAL_SERVER_ERROR',
      requests: 4,
    });
  });
});

describe('syncItem', () => {
  const tx = (id: string) => ({
    transaction_id: id,
    account_id: 'card',
    amount: 1,
    iso_currency_code: 'USD',
    date: '2026-09-27',
    name: 'x',
    pending: false,
  });
  const page = (fields: object) => ({
    added: [],
    modified: [],
    removed: [],
    next_cursor: 'c',
    has_more: false,
    ...fields,
  });
  const mutated = {
    status: 400,
    body: {
      error_type: 'TRANSACTIONS_ERROR',
      error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    },
  };

  /** Answers in turn, and remembers each request's cursor. */
  function plaid(answers: { status: number; body: unknown }[]) {
    const sent: unknown[] = [];
    const fetcher: typeof fetch = (_input, init) => {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      sent.push(typeof body === 'object' && body !== null && 'cursor' in body ? body.cursor : null);
      const answer = answers.shift() ?? { status: 500, body: {} };
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    };
    return { fetcher, sent };
  }

  it('reads every page from the cursor it was given, and ends on the last cursor', async () => {
    const p = plaid([
      { status: 200, body: page({ added: [tx('a')], next_cursor: 'c1', has_more: true }) },
      { status: 200, body: page({ added: [tx('b')], next_cursor: 'c2' }) },
    ]);
    const got = await syncItem(keys, 't', 'I', 'c0', p.fetcher);
    expect(got).toMatchObject({ ok: true, requests: 2, synced: { item: 'I', cursor: 'c2' } });
    expect(got.ok && got.synced.transactions.map((t) => t.transaction_id)).toEqual(['a', 'b']);
    expect(p.sent).toEqual(['c0', 'c1']);
  });

  it('asks for everything when there is no cursor yet', async () => {
    const p = plaid([{ status: 200, body: page({}) }]);
    await syncItem(keys, 't', 'I', '', p.fetcher);
    expect(p.sent).toEqual([null]);
  });

  it('starts again from the first cursor when Plaid changed the pages underneath', async () => {
    const p = plaid([
      { status: 200, body: page({ added: [tx('stale')], next_cursor: 'c1', has_more: true }) },
      mutated,
      { status: 200, body: page({ added: [tx('fresh')], next_cursor: 'c9' }) },
    ]);
    const got = await syncItem(keys, 't', 'I', 'c0', p.fetcher);
    expect(p.sent).toEqual(['c0', 'c1', 'c0']);
    expect(got.ok && got.synced.transactions.map((t) => t.transaction_id)).toEqual(['fresh']);
    expect(got.ok && got.requests).toBe(3);
  });

  it('gives up on the item after three tries', async () => {
    const got = await syncItem(keys, 't', 'I', 'c0', plaid([mutated, mutated, mutated]).fetcher);
    expect(got).toEqual({
      ok: false,
      reason: 'Plaid kept changing the transactions while they were read',
      code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
      requests: 3,
    });
  });

  it('stops at the page cap and keeps what it read, to carry on tomorrow', async () => {
    const more = { status: 200, body: page({ next_cursor: 'n', has_more: true }) };
    const got = await syncItem(
      keys,
      't',
      'I',
      'c0',
      plaid(Array.from({ length: 30 }, () => more)).fetcher,
    );
    expect(got).toMatchObject({ ok: true, requests: 20, synced: { cursor: 'n' } });
  });

  it('says why, by code, when Plaid refuses or answers oddly', async () => {
    const login = { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' };
    expect(
      await syncItem(keys, 't', 'I', '', plaid([{ status: 400, body: login }]).fetcher),
    ).toEqual({
      ok: false,
      reason: 'Plaid refused /transactions/sync: HTTP 400, ITEM_ERROR/ITEM_LOGIN_REQUIRED',
      code: 'ITEM_LOGIN_REQUIRED',
      requests: 1,
    });
    expect(
      await syncItem(keys, 't', 'I', '', plaid([{ status: 200, body: { added: 'no' } }]).fetcher),
    ).toMatchObject({ ok: false, code: null, requests: 1 });
  });
});
