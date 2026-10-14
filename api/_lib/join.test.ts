import { describe, expect, it } from 'vitest';

import { join } from './join.ts';

const OWNER = '11111111-1111-1111-1111-111111111111';
const COPY = '22222222-2222-4222-8222-222222222222';
const BANK = '33333333-3333-4333-8333-333333333333';
const ENV = { SUPABASE_URL: 'https://db.test/', SUPABASE_SECRET_KEY: 'sb_secret_x' };
const JOINED = { days_moved: 815, days_left: 1, transactions_moved: 40, transactions_left: 2 };

type Call = { readonly url: string; readonly body: unknown };

function world(
  w: { readonly user?: string | null | undefined; readonly store?: () => Response } = {},
) {
  const calls: Call[] = [];
  const fake: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url === 'https://db.test/auth/v1/user') {
      const user = w.user === undefined ? OWNER : w.user;
      return Promise.resolve(
        user === null ? new Response('{}', { status: 401 }) : Response.json({ id: user }),
      );
    }
    if (url.startsWith('https://db.test/auth/v1/admin/users')) {
      return Promise.resolve(Response.json({ users: [{ id: OWNER }] }));
    }
    if (url === 'https://db.test/rest/v1/rpc/monarch_join') {
      return Promise.resolve(w.store?.() ?? Response.json(JOINED));
    }
    return Promise.resolve(new Response('unrouted', { status: 599 }));
  };
  return { fetch: fake, calls };
}

function asked(body: unknown, bearer: string | null = 'session') {
  return new Request('https://dinora.test/api/monarch/join', {
    method: 'POST',
    headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

describe('join (BANK-17)', () => {
  it('moves the pair as the owner, and answers with the counts', async () => {
    const w = world();
    const { status, answer } = await join(asked({ monarch: COPY, bank: BANK }), ENV, w.fetch);
    expect(status).toBe(200);
    expect(answer).toEqual({ kind: 'joined', ...JOINED });
    const store = w.calls.find((c) => c.url.endsWith('/rpc/monarch_join'));
    expect(store?.body).toEqual({ p_user: OWNER, p_copy: COPY, p_bank: BANK });
  });

  it('refuses anyone but the owner before asking the database anything', async () => {
    for (const [request, user, code] of [
      [asked({ monarch: COPY, bank: BANK }, null), undefined, 401],
      [asked({ monarch: COPY, bank: BANK }), null, 401],
      [asked({ monarch: COPY, bank: BANK }), '44444444-4444-4444-8444-444444444444', 403],
    ] as const) {
      const w = world({ user });
      const { status, answer } = await join(request, ENV, w.fetch);
      expect(status).toBe(code);
      expect(answer.kind).toBe('refused');
      expect(w.calls.some((c) => c.url.endsWith('/rpc/monarch_join'))).toBe(false);
    }
  });

  it('refuses a body that is not two ids', async () => {
    const w = world();
    const { status } = await join(asked({ monarch: 'Orchard Card', bank: BANK }), ENV, w.fetch);
    expect(status).toBe(400);
    expect(w.calls.some((c) => c.url.endsWith('/rpc/monarch_join'))).toBe(false);
  });

  it("says the database's refusal in her words", async () => {
    const w = world({
      store: () =>
        Response.json({ code: 'P0001', message: 'monarch_join: taken' }, { status: 400 }),
    });
    const { status, answer } = await join(asked({ monarch: COPY, bank: BANK }), ENV, w.fetch);
    expect(status).toBe(409);
    expect(answer).toEqual({
      kind: 'refused',
      reason: 'another Monarch account is already put together with this bank account',
    });
  });

  it('never passes on the message of an error it does not know', async () => {
    const w = world({
      store: () =>
        Response.json(
          { message: 'duplicate key value (Groceries, 45.10)', details: 'Key (payee)=(Grocer)' },
          { status: 409 },
        ),
    });
    const { status, answer } = await join(asked({ monarch: COPY, bank: BANK }), ENV, w.fetch);
    expect(status).toBe(502);
    expect(answer).toEqual({ kind: 'refused', reason: 'the database answered HTTP 409' });
  });

  it('refuses when not configured', async () => {
    const { status } = await join(asked({ monarch: COPY, bank: BANK }), {}, world().fetch);
    expect(status).toBe(503);
  });
});
