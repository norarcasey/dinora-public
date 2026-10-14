import { describe, expect, it } from 'vitest';

import { rates, ratesUrl } from './rates.ts';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-24T09:00:00.000Z');
const ENV = { SUPABASE_URL: 'https://db.test/', SUPABASE_SECRET_KEY: 'sb_secret_x' };

// As Frankfurter answered with providers=ECB on 24 Sep 2026, cut to two days.
const ECB = [
  { date: '2026-09-18', base: 'EUR', quote: 'USD', rate: 1.146 },
  { date: '2026-09-23', base: 'EUR', quote: 'USD', rate: 1.1411 },
];

type Call = { url: string; method: string; body: unknown; headers: Headers };

function world(overrides: { frankfurter?: unknown; users?: unknown; store?: Response } = {}) {
  const calls: Call[] = [];
  const route = (url: string): Response => {
    if (url.startsWith('https://db.test/auth/v1/admin/users')) {
      return Response.json(overrides.users ?? { users: [{ id: USER }] });
    }
    if (url.startsWith('https://api.frankfurter.dev/')) {
      const f = overrides.frankfurter ?? ECB;
      return f instanceof Response ? f.clone() : Response.json(f);
    }
    if (url.startsWith('https://db.test/rest/v1/fx_rates')) {
      return overrides.store ?? new Response(null, { status: 201 });
    }
    return new Response('unrouted', { status: 599 });
  };
  const fake: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) });
    return Promise.resolve(route(url));
  };
  return { calls, fetch: fake };
}

describe('the rates read', () => {
  it("asks for the ECB's own rates over the last 90 days", () => {
    const url = new URL(ratesUrl('EUR', 'USD', NOW));
    expect(url.origin + url.pathname).toBe('https://api.frankfurter.dev/v2/rates');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      base: 'EUR',
      quotes: 'USD',
      providers: 'ECB',
      from: '2026-06-26',
      to: '2026-09-24',
    });
  });

  it('stores every rate for the one user, keeping any already stored', async () => {
    const w = world();
    expect(await rates(ENV, w.fetch, NOW)).toEqual({ ok: true, read: 2, newest: '2026-09-23' });
    const store = w.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/fx_rates'));
    expect(store?.method).toBe('POST');
    expect(store?.url).toContain('on_conflict=user_id,source,base,quote,rate_date');
    expect(store?.headers.get('Prefer')).toContain('resolution=ignore-duplicates');
    expect(store?.headers.get('Authorization')).toBe('Bearer sb_secret_x');
    expect(store?.body).toEqual([
      {
        user_id: USER,
        source: 'ecb',
        base: 'EUR',
        quote: 'USD',
        rate_date: '2026-09-18',
        rate: '1.146',
      },
      {
        user_id: USER,
        source: 'ecb',
        base: 'EUR',
        quote: 'USD',
        rate_date: '2026-09-23',
        rate: '1.1411',
      },
    ]);
  });

  it('stores nothing when there is nothing to store', async () => {
    const w = world({ frankfurter: [] });
    expect(await rates(ENV, w.fetch, NOW)).toEqual({ ok: true, read: 0, newest: null });
    expect(w.calls.some((c) => c.url.includes('fx_rates'))).toBe(false);
  });

  it('refuses to run unconfigured', async () => {
    const w = world();
    expect(await rates({}, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'not configured: SUPABASE_URL, SUPABASE_SECRET_KEY',
    });
    expect(w.calls).toEqual([]);
  });

  it.each([
    [{ users: { users: [] } }, 'expected exactly one user, found none'],
    [{ frankfurter: new Response('', { status: 503 }) }, 'Frankfurter answered HTTP 503'],
    [{ frankfurter: { rates: {} } }, 'Frankfurter answered in an unexpected shape'],
    [{ frankfurter: new Response('<html>') }, 'Frankfurter answered in an unexpected shape'],
    [
      { frankfurter: [{ date: '2026-09-18', base: 'EUR', quote: 'GBP', rate: 0.87 }] },
      'Frankfurter answered for a pair it was not asked for',
    ],
    [{ store: new Response(null, { status: 403 }) }, 'storing rates answered HTTP 403'],
  ])('fails with a reason and no amount: %#', async (overrides, reason) => {
    const w = world(overrides);
    expect(await rates(ENV, w.fetch, NOW)).toEqual({ ok: false, reason });
  });

  it('fails when Frankfurter does not answer', async () => {
    const w = world();
    const silent: typeof fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith(
        'https://api.frankfurter.dev/',
      )
        ? Promise.reject(new Error('timeout'))
        : w.fetch(input, init);
    expect(await rates(ENV, silent, NOW)).toEqual({
      ok: false,
      reason: 'Frankfurter did not answer for EUR to USD',
    });
  });
});
