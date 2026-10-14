import { describe, expect, it } from 'vitest';

import { coins, GEMINI_URL } from './crypto.ts';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-27T09:00:00.000Z');
const ENV = { SUPABASE_URL: 'https://db.test/', SUPABASE_SECRET_KEY: 'sb_secret_x' };

const BTC = {
  id: 'btc',
  currency: 'USD',
  coin: 'BTC',
  coin_quantity: '0.0123',
  deleted_at: null,
};

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);

// The shape of Gemini's answer, trimmed: newest first, stamped at the start of each UTC day.
const BTC_CANDLES = [
  [at('2026-09-26'), 84098, 85000, 83000, 84500.5, 100.1],
  [at('2026-09-25'), 84384.61, 85231.07, 83182.95, 84098, 133.32449757],
  [at('2026-09-24'), 84385.1, 84899.74, 82858.23, 84384.61, 172.96784467],
  [at('2026-08-01'), 1, 1, 1, 60000, 1],
];

const SHIB_CANDLES = [[at('2026-09-26'), 0.000005776, 0.000006, 0.0000057, 0.000005959, 3.8e9]];

type Call = { url: string; method: string; body: unknown };

function world(
  overrides: {
    assets?: unknown;
    valued?: unknown;
    symbols?: Response;
    candles?: Response;
    storePrices?: Response;
  } = {},
) {
  const calls: Call[] = [];
  const route = (url: string, method: string): Response => {
    if (url.startsWith('https://db.test/auth/v1/admin/users')) {
      return Response.json({ users: [{ id: USER }] });
    }
    if (url.startsWith('https://db.test/rest/v1/assets')) {
      return Response.json(overrides.assets ?? [BTC]);
    }
    if (url.startsWith('https://db.test/rest/v1/crypto_prices')) {
      return overrides.storePrices?.clone() ?? new Response(null, { status: 201 });
    }
    if (url.startsWith('https://db.test/rest/v1/asset_values')) {
      if (method === 'POST') return new Response(null, { status: 201 });
      return Response.json(overrides.valued ?? []);
    }
    if (url === `${GEMINI_URL}/v1/symbols`) {
      return overrides.symbols?.clone() ?? Response.json(['btcusd', 'btcgusd', 'shibusd']);
    }
    if (url === `${GEMINI_URL}/v2/candles/btcusd/1day`) {
      return overrides.candles?.clone() ?? Response.json(BTC_CANDLES);
    }
    if (url === `${GEMINI_URL}/v2/candles/shibusd/1day`) return Response.json(SHIB_CANDLES);
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
  const gemini = () => calls.filter((c) => c.url.startsWith(GEMINI_URL));
  return { calls, fetch: fake, posted, gemini };
}

describe('the nightly crypto read', () => {
  it('asks Gemini nothing when she holds no coin', async () => {
    const w = world({ assets: [] });
    expect(await coins(ENV, w.fetch, NOW)).toEqual({
      ok: true,
      prices: 0,
      values: 0,
      newest: null,
      unlisted: 0,
    });
    expect(w.gemini()).toEqual([]);
  });

  it('reads only the coin and quantity, as text, of crypto', async () => {
    const w = world();
    await coins(ENV, w.fetch, NOW);
    const read = w.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/assets'));
    const query = new URL(read?.url ?? 'https://x').searchParams;
    expect(query.get('select')).toBe('id,currency,coin,coin_quantity::text,deleted_at');
    expect(query.get('kind')).toBe('eq.crypto');
  });

  it('stores a month of completed closes, and a value at the newest with the quantity', async () => {
    const w = world();
    expect(await coins(ENV, w.fetch, NOW)).toEqual({
      ok: true,
      prices: 3,
      values: 1,
      newest: '2026-09-26',
      unlisted: 0,
    });
    const prices = w.posted('crypto_prices');
    expect(prices?.url).toContain('on_conflict=user_id,source,coin,currency,price_date');
    expect(prices?.body).toEqual(
      [
        ['2026-09-24', '84384.61'],
        ['2026-09-25', '84098'],
        ['2026-09-26', '84500.5'],
      ].map(([day, price]) => ({
        source: 'gemini',
        coin: 'BTC',
        currency: 'USD',
        price_date: day,
        price,
        user_id: USER,
      })),
    );
    const values = w.posted('asset_values');
    expect(values?.url).toContain('on_conflict=user_id,asset_id,provider,valued_on');
    // 0.0123 × 84,500.5 is 1,039.35615 dollars.
    expect(values?.body).toEqual([
      {
        asset_id: 'btc',
        valued_on: '2026-09-26',
        amount_minor: 103_936,
        source: 'estimate',
        provider: 'gemini',
        low_minor: null,
        high_minor: null,
        coin_quantity: '0.0123',
        user_id: USER,
      },
    ]);
  });

  it('writes no second value for a day already valued', async () => {
    const w = world({ valued: [{ asset_id: 'btc', valued_on: '2026-09-26' }] });
    expect(await coins(ENV, w.fetch, NOW)).toMatchObject({ ok: true, values: 0 });
    expect(w.posted('asset_values')).toBeUndefined();
  });

  it('asks for each coin once, and prices a memecoin in millionths exactly', async () => {
    const w = world({
      assets: [
        BTC,
        { ...BTC, id: 'btc2' },
        { ...BTC, id: 'shib', coin: 'SHIB', coin_quantity: '12500000' },
      ],
    });
    expect(await coins(ENV, w.fetch, NOW)).toMatchObject({ ok: true, values: 3 });
    expect(w.gemini().map((c) => c.url.slice(GEMINI_URL.length))).toEqual([
      '/v1/symbols',
      '/v2/candles/btcusd/1day',
      '/v2/candles/shibusd/1day',
    ]);
    expect(w.posted('asset_values')?.body).toContainEqual(
      expect.objectContaining({ asset_id: 'shib', amount_minor: 7_449 }),
    );
  });

  it('counts and skips a coin Gemini does not price in dollars, without failing', async () => {
    const w = world({ assets: [BTC, { ...BTC, id: 'nope', coin: 'NOPE' }] });
    expect(await coins(ENV, w.fetch, NOW)).toMatchObject({ ok: true, values: 1, unlisted: 1 });
    expect(w.gemini().some((c) => c.url.includes('nopeusd'))).toBe(false);
  });

  it('fails, storing nothing, when Gemini does not answer or answers oddly', async () => {
    const answers: { symbols?: Response; candles?: Response }[] = [
      { symbols: new Response('down', { status: 503 }) },
      { symbols: Response.json({ not: 'a list' }) },
      { candles: new Response('down', { status: 503 }) },
      { candles: new Response('not json') },
      { candles: Response.json([[at('2026-09-25') + 3_600_000, 1, 1, 1, 1, 1]]) },
    ];
    for (const answer of answers) {
      const w = world(answer);
      const outcome = await coins(ENV, w.fetch, NOW);
      expect(outcome.ok).toBe(false);
      expect(w.calls.filter((c) => c.method === 'POST')).toEqual([]);
    }
  });

  it('says why a store failed, in words that carry no figure and no coin', async () => {
    const w = world({ storePrices: new Response(null, { status: 400 }) });
    expect(await coins(ENV, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'storing prices answered HTTP 400',
    });
  });

  it('refuses to run unconfigured', async () => {
    const w = world();
    expect(await coins({}, w.fetch, NOW)).toEqual({
      ok: false,
      reason: 'not configured: SUPABASE_URL, SUPABASE_SECRET_KEY',
    });
  });
});
