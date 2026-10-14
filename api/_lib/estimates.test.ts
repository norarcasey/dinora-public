import { describe, expect, it } from 'vitest';

import { estimates, requestFor } from './estimates.ts';

const USER = '11111111-1111-1111-1111-111111111111';
const TODAY = '2026-09-25';
const NOW = new Date('2026-09-25T09:12:00.000Z');
const ENV = {
  SUPABASE_URL: 'https://db.test/',
  SUPABASE_SECRET_KEY: 'sb_secret_x',
  RENTCAST_API_KEY: 'rc_key',
  MARKETCHECK_API_KEY: 'mc_key',
};

const HOME = {
  id: 'home',
  kind: 'home',
  currency: 'USD',
  address: '1 Main St, Springfield, IL, 62701',
  postal_code: null,
  vin: null,
  odometer_miles: null,
  odometer_on: null,
  deleted_at: null,
};

const CAR = {
  ...HOME,
  id: 'car',
  kind: 'vehicle',
  address: null,
  postal_code: '62704',
  vin: '2HGFE1F50PH000001',
  odometer_miles: 21_000,
  odometer_on: '2026-09-01',
};

const JEWELRY = { ...HOME, id: 'jewelry', kind: 'valuables', address: null };

type Call = { url: string; method: string; body: unknown; headers: Headers };

function world(
  overrides: {
    assets?: unknown;
    days?: unknown;
    rentcast?: Response;
    marketcheck?: Response;
    store?: Response;
  } = {},
) {
  const calls: Call[] = [];
  const route = (url: string, method: string): Response => {
    if (url.startsWith('https://db.test/auth/v1/admin/users')) {
      return Response.json({ users: [{ id: USER }] });
    }
    if (url.startsWith('https://db.test/rest/v1/assets')) {
      return Response.json(overrides.assets ?? [HOME, CAR, JEWELRY]);
    }
    if (url.startsWith('https://db.test/rest/v1/asset_values')) {
      if (method === 'POST') return overrides.store ?? new Response(null, { status: 201 });
      return Response.json(overrides.days ?? []);
    }
    if (url.startsWith('https://api.rentcast.io/')) {
      return (
        overrides.rentcast?.clone() ??
        Response.json({ price: 527_400, priceRangeLow: 500_000, priceRangeHigh: 600_000 })
      );
    }
    if (url.startsWith('https://api.marketcheck.com/')) {
      return overrides.marketcheck?.clone() ?? Response.json({ marketcheck_price: 27_450 });
    }
    return new Response('unrouted', { status: 599 });
  };
  const fake: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body, headers: new Headers(init?.headers) });
    return Promise.resolve(route(url, method));
  };
  const asked = (origin: string) => calls.filter((c) => c.url.startsWith(origin)).length;
  return { calls, fetch: fake, asked };
}

describe('the requests', () => {
  it('asks RentCast with the address and a wider set of comparables, its key in a header', () => {
    const { url, headers } = requestFor(
      { provider: 'rentcast', assetId: 'home', address: '1 Main St, Springfield, IL, 62701' },
      'rc_key',
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.rentcast.io/v1/avm/value');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      address: '1 Main St, Springfield, IL, 62701',
      compCount: '25',
      daysOld: '365',
    });
    expect(new Headers(headers).get('X-Api-Key')).toBe('rc_key');
  });

  it('asks MarketCheck with the VIN, the mileage and the ZIP code, as a franchise dealer', () => {
    const { url } = requestFor(
      {
        provider: 'marketcheck',
        assetId: 'car',
        vin: '2HGFE1F50PH000001',
        postalCode: '62704',
        miles: 21_000,
      },
      'mc_key',
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/v2/predict/car/us/marketcheck_price');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      api_key: 'mc_key',
      vin: '2HGFE1F50PH000001',
      miles: '21000',
      zip: '62704',
      dealer_type: 'franchise',
    });
  });
});

describe('the weekly estimate read', () => {
  it('asks about the home and the car, and stores both as estimates for the one user', async () => {
    const w = world();
    expect(await estimates(ENV, w.fetch, NOW)).toEqual({
      ok: true,
      asked: 2,
      later: false,
      stored: 2,
      unconfigured: [],
    });
    const store = w.calls.find((c) => c.method === 'POST');
    expect(store?.url).toContain('on_conflict=user_id,asset_id,provider,valued_on');
    expect(store?.headers.get('Prefer')).toContain('resolution=ignore-duplicates');
    expect(store?.body).toEqual([
      {
        user_id: USER,
        asset_id: 'home',
        valued_on: TODAY,
        amount_minor: 52_740_000,
        source: 'estimate',
        provider: 'rentcast',
        low_minor: 50_000_000,
        high_minor: 60_000_000,
      },
      {
        user_id: USER,
        asset_id: 'car',
        valued_on: TODAY,
        amount_minor: 2_745_000,
        source: 'estimate',
        provider: 'marketcheck',
        low_minor: null,
        high_minor: null,
      },
    ]);
  });

  it('reads only what the sources are asked with, and only her live assets', async () => {
    const w = world();
    await estimates(ENV, w.fetch, NOW);
    const read = w.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/assets'));
    expect(read?.url).toContain(`user_id=eq.${USER}`);
    expect(read?.url).toContain('deleted_at=is.null');
    expect(read?.url).not.toMatch(/name|cost_minor|amount_minor/);
  });

  it('asks nobody about an asset estimated within the week', async () => {
    const w = world({
      days: [
        { asset_id: 'home', provider: 'rentcast', valued_on: '2026-09-20' },
        { asset_id: 'car', provider: 'marketcheck', valued_on: '2026-09-18' },
      ],
    });
    expect(await estimates(ENV, w.fetch, NOW)).toMatchObject({ ok: true, asked: 1, stored: 1 });
    expect(w.asked('https://api.rentcast.io/')).toBe(0);
    expect(w.asked('https://api.marketcheck.com/')).toBe(1);
  });

  it('asks nobody on the later run, so a failed day is tried again tomorrow, not in two hours', async () => {
    const w = world();
    const later = new Date('2026-09-25T11:05:00.000Z');
    expect(await estimates(ENV, w.fetch, later)).toEqual({
      ok: true,
      asked: 0,
      later: true,
      stored: 0,
      unconfigured: [],
    });
    expect(w.calls).toHaveLength(0);
  });

  it('writes nothing when nothing is due', async () => {
    const w = world({ assets: [JEWELRY] });
    expect(await estimates(ENV, w.fetch, NOW)).toEqual({
      ok: true,
      asked: 0,
      later: false,
      stored: 0,
      unconfigured: [],
    });
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('skips a provider with no key, and says so, without failing', async () => {
    const w = world();
    const outcome = await estimates({ ...ENV, MARKETCHECK_API_KEY: '' }, w.fetch, NOW);
    expect(outcome).toEqual({
      ok: true,
      asked: 1,
      later: false,
      stored: 1,
      unconfigured: ['marketcheck'],
    });
    expect(w.asked('https://api.marketcheck.com/')).toBe(0);
  });

  it('stores what answered and fails for what did not, naming no address or VIN', async () => {
    const w = world({ marketcheck: new Response('no', { status: 422 }) });
    const outcome = await estimates(ENV, w.fetch, NOW);
    expect(outcome).toEqual({ ok: false, reason: 'MarketCheck answered HTTP 422' });
    const store = w.calls.find((c) => c.method === 'POST');
    expect(store?.body).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toMatch(/Main St|4T3R|mc_key/);
  });

  it('fails for an answer with no price', async () => {
    const w = world({
      assets: [CAR],
      marketcheck: Response.json({ marketcheck_price: null, msrp: null }),
    });
    expect(await estimates(ENV, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'MarketCheck answered with no price',
    });
  });

  it('fails for a provider that does not answer', async () => {
    const w = world({ assets: [HOME] });
    const failing: typeof fetch = (input, init) =>
      (input instanceof Request ? input.url : input.toString()).startsWith(
        'https://api.rentcast.io/',
      )
        ? Promise.reject(new Error('timeout'))
        : w.fetch(input, init);
    expect(await estimates(ENV, failing, NOW)).toEqual({
      ok: false,
      reason: 'RentCast did not answer',
    });
  });

  it('fails when the store refuses', async () => {
    const w = world({ store: new Response(null, { status: 403 }) });
    expect(await estimates(ENV, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'storing estimates answered HTTP 403',
    });
  });

  it('fails when reading assets does', async () => {
    const w = world({ assets: { not: 'rows' } });
    expect(await estimates(ENV, w.fetch, NOW)).toMatchObject({ ok: false });
  });

  it('fails unconfigured without the database', async () => {
    const w = world();
    expect(await estimates({}, w.fetch, NOW)).toMatchObject({ ok: false });
    expect(w.calls).toHaveLength(0);
  });
});
