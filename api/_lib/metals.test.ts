import { describe, expect, it } from 'vitest';

import { LBMA_URLS, metals } from './metals.ts';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-25T09:12:00.000Z');
const ENV = { SUPABASE_URL: 'https://db.test/', SUPABASE_SECRET_KEY: 'sb_secret_x' };

const BRACELET = {
  id: 'bracelet',
  currency: 'USD',
  acquired_on: '2022-03-01',
  metal: 'gold',
  metal_mg: 52_300,
  fineness: 750,
  deleted_at: null,
};

const SILVER = {
  ...BRACELET,
  id: 'silver',
  acquired_on: null,
  metal: 'silver',
  metal_mg: 1_000_000,
  fineness: 925,
};

// The shape of the LBMA's files, trimmed to a few days either side of the purchase and today.
const GOLD_FILE = [
  { is_cms_locked: 0, d: '2022-02-18', v: [1895.1, 1393.7, 1673.13] },
  { is_cms_locked: 0, d: '2022-02-28', v: [1900, 1418.47, 1696.23] },
  { is_cms_locked: 0, d: '2022-03-01', v: [1922, 1435.54, 1724.23] },
  { is_cms_locked: 0, d: '2026-09-23', v: [4284.45, 3229.62, 3757.89] },
  { is_cms_locked: 0, d: '2026-09-24', v: [4266.4, 3227.53, 3751.87] },
];

const SILVER_FILE = [
  { is_cms_locked: 0, d: '2026-09-23', v: [65.185, 49.04, 57.1] },
  { is_cms_locked: 0, d: '2026-09-24', v: [63.58, 48.06, 55.9] },
];

type Call = { url: string; method: string; body: unknown };

function world(
  overrides: {
    assets?: unknown;
    stored?: { first: string; last: string };
    valued?: unknown;
    gold?: Response;
    storePrices?: Response;
  } = {},
) {
  const calls: Call[] = [];
  const route = (url: string, method: string): Response => {
    if (url.startsWith('https://db.test/auth/v1/admin/users')) {
      return Response.json({ users: [{ id: USER }] });
    }
    if (url.startsWith('https://db.test/rest/v1/assets')) {
      return Response.json(overrides.assets ?? [BRACELET]);
    }
    if (url.startsWith('https://db.test/rest/v1/metal_prices')) {
      if (method === 'POST') return overrides.storePrices ?? new Response(null, { status: 201 });
      const stored = overrides.stored;
      if (stored === undefined) return Response.json([]);
      return Response.json([
        { price_date: url.includes('price_date.asc') ? stored.first : stored.last },
      ]);
    }
    if (url.startsWith('https://db.test/rest/v1/asset_values')) {
      if (method === 'POST') return new Response(null, { status: 201 });
      return Response.json(overrides.valued ?? []);
    }
    if (url === LBMA_URLS.gold) return overrides.gold?.clone() ?? Response.json(GOLD_FILE);
    if (url === LBMA_URLS.silver) return Response.json(SILVER_FILE);
    return new Response('unrouted', { status: 599 });
  };
  const fake: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body });
    return Promise.resolve(route(url, method));
  };
  const posted = (table: string) =>
    calls.find((c) => c.method === 'POST' && c.url.includes(`/rest/v1/${table}?`));
  return { calls, fetch: fake, posted };
}

describe('the nightly metal read', () => {
  it('asks the LBMA nothing when she owns no metal', async () => {
    const w = world({ assets: [] });
    expect(await metals(ENV, w.fetch, NOW)).toEqual({ ok: true, prices: 0, values: 0, newest: {} });
    expect(w.calls.some((c) => c.url.startsWith('https://prices.lbma.org.uk/'))).toBe(false);
  });

  it('reads only what a value is worked out from, and only pieces of metal', async () => {
    const w = world();
    await metals(ENV, w.fetch, NOW);
    const read = w.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/assets'));
    const query = new URL(read?.url ?? 'https://x').searchParams;
    expect(query.get('select')).toBe('id,currency,acquired_on,metal,metal_mg,fineness,deleted_at');
    expect(query.get('metal')).toBe('not.is.null');
  });

  it('stores the prices from a week before the purchase, and a value at the newest', async () => {
    const w = world();
    expect(await metals(ENV, w.fetch, NOW)).toEqual({
      ok: true,
      prices: 4,
      values: 1,
      newest: { gold: '2026-09-24' },
    });
    const prices = w.posted('metal_prices');
    expect(prices?.url).toContain('on_conflict=user_id,source,metal,currency,price_date');
    expect(prices?.body).toEqual(
      ['2022-02-28', '2022-03-01', '2026-09-23', '2026-09-24'].map((d, i) => ({
        source: 'lbma',
        metal: 'gold',
        currency: 'USD',
        price_date: d,
        price: ['1900', '1922', '4284.45', '4266.4'][i],
        user_id: USER,
      })),
    );
    expect(w.posted('asset_values')?.body).toEqual([
      {
        asset_id: 'bracelet',
        valued_on: '2026-09-24',
        amount_minor: 538_041,
        source: 'estimate',
        provider: 'lbma',
        low_minor: null,
        high_minor: null,
        user_id: USER,
      },
    ]);
  });

  it('sends only the days past what is stored, and no value twice for a day', async () => {
    const w = world({
      stored: { first: '2022-02-28', last: '2026-09-23' },
      valued: [{ asset_id: 'bracelet', valued_on: '2026-09-24' }],
    });
    expect(await metals(ENV, w.fetch, NOW)).toMatchObject({ ok: true, prices: 1, values: 0 });
    expect(w.posted('asset_values')).toBeUndefined();
  });

  it('writes nothing on a night the LBMA has added nothing', async () => {
    const w = world({
      stored: { first: '2022-02-28', last: '2026-09-24' },
      valued: [{ asset_id: 'bracelet', valued_on: '2026-09-24' }],
    });
    expect(await metals(ENV, w.fetch, NOW)).toMatchObject({ ok: true, prices: 0, values: 0 });
    expect(w.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('reads each metal once, gold for gold and silver for silver', async () => {
    const w = world({ assets: [BRACELET, SILVER] });
    expect(await metals(ENV, w.fetch, NOW)).toMatchObject({
      ok: true,
      values: 2,
      newest: { gold: '2026-09-24', silver: '2026-09-24' },
    });
    const files = w.calls.filter((c) => c.url.startsWith('https://prices.lbma.org.uk/'));
    expect(files.map((c) => c.url).sort()).toEqual([LBMA_URLS.gold, LBMA_URLS.silver]);
  });

  it('fails, storing nothing, when the LBMA does not answer or answers oddly', async () => {
    for (const gold of [
      new Response('down', { status: 503 }),
      Response.json({ not: 'a list' }),
      Response.json([{ d: '2026-09-24', v: [1e-7, null, null] }]),
    ]) {
      const w = world({ gold });
      const outcome = await metals(ENV, w.fetch, NOW);
      expect(outcome.ok).toBe(false);
      expect(w.calls.filter((c) => c.method === 'POST')).toEqual([]);
    }
  });

  it('says why a store failed, in words that carry no figure', async () => {
    const w = world({ storePrices: new Response(null, { status: 400 }) });
    expect(await metals(ENV, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'storing prices answered HTTP 400',
    });
  });

  it('refuses to run unconfigured', async () => {
    const w = world();
    expect(await metals({}, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'not configured: SUPABASE_URL, SUPABASE_SECRET_KEY',
    });
  });
});
