import { describe, expect, it } from 'vitest';

import { windows } from '../../packages/core/src/simplefin.ts';
import { DEMO_ACCESS_URL, GIST_CHARS, access, accountsUrl, gist, pull } from './simplefin.ts';

describe('access', () => {
  it('moves the credential into a Basic header and leaves a base safe to print', () => {
    expect(access(DEMO_ACCESS_URL)).toEqual({
      base: 'https://beta-bridge.simplefin.org/simplefin',
      authorization: `Basic ${Buffer.from('demo:demo').toString('base64')}`,
    });
  });

  it('decodes an escaped credential before encoding it', () => {
    expect(access('https://a%40b:p%3Aw@x.test/simplefin/')?.authorization).toBe(
      `Basic ${Buffer.from('a@b:p:w').toString('base64')}`,
    );
  });

  it('refuses a URL without a credential, or not https', () => {
    expect(access('https://x.test/simplefin')).toBeNull();
    expect(access('http://u:p@x.test/simplefin')).toBeNull();
    expect(access('nonsense')).toBeNull();
  });
});

describe('accountsUrl', () => {
  it('asks for version 2 with pending, over the window', () => {
    expect(accountsUrl('https://x.test/simplefin', { start: 10, end: 20 })).toBe(
      'https://x.test/simplefin/accounts?version=2&pending=1&start-date=10&end-date=20',
    );
  });
});

function bridgeAnswer(transactionIds: readonly string[]): unknown {
  return {
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
        transactions: transactionIds.map((id) => ({
          id,
          posted: 900,
          amount: '-1.00',
          description: 'x',
        })),
      },
    ],
  };
}

const credential = { base: 'https://x.test/simplefin', authorization: 'Basic eDp5' };

/** Each answer in turn: a Response as given, anything else as its JSON. */
function answering(...bodies: readonly unknown[]): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const fake: typeof fetch = (input) => {
    urls.push(input instanceof Request ? input.url : input.toString());
    const body = bodies[i++];
    return Promise.resolve(body instanceof Response ? body : Response.json(body));
  };
  return { fetch: fake, urls };
}

describe('gist', () => {
  it('keeps the words of an HTML error page and none of its markup', () => {
    const page =
      '<html><head><style>p{color:red}</style><title>502 Bad Gateway</title></head>' +
      '<body><script>var x = 1;</script><h1>Bad   Gateway</h1></body></html>';
    expect(gist(page)).toBe('### Bad Gateway Bad Gateway');
  });

  it('cuts a long body short and says so', () => {
    const said = gist('word '.repeat(100));
    expect(said).toHaveLength(GIST_CHARS);
    expect(said.endsWith('…')).toBe(true);
  });

  it('is empty for an empty body', () => {
    expect(gist(' \n ')).toBe('');
  });
});

describe('pull', () => {
  const wanted = windows(10_000_000, 3);

  it('combines every window, newest first', async () => {
    const f = answering(bridgeAnswer(['t1', 't2']), bridgeAnswer(['t2', 't0']), bridgeAnswer([]));
    const pulled = await pull(credential, wanted, { fetch: f.fetch, order: 'together' });
    expect(pulled.ok && pulled.rows.transactions.map((t) => t.source_id)).toEqual([
      't1',
      't2',
      't0',
    ]);
    expect(pulled.ok && pulled.covered).toHaveLength(3);
    expect(pulled.requests).toBe(3);
    expect(f.urls[0]).toContain(`start-date=${wanted[0]?.start}`);
  });

  it('stops at the first empty window after the newest when asked', async () => {
    const f = answering(bridgeAnswer(['t1']), bridgeAnswer([]), bridgeAnswer(['never']));
    const seen: number[] = [];
    const pulled = await pull(credential, wanted, {
      fetch: f.fetch,
      order: 'untilEmpty',
      onWindow: (_, n) => seen.push(n),
    });
    expect(pulled.ok && pulled.covered).toHaveLength(2);
    expect(seen).toEqual([1, 0]);
  });

  it.each([
    [new Response('', { status: 403 }), /403/],
    [new Response('', { status: 502 }), /HTTP 502/],
    [new Response('<html>', { status: 200 }), /other than JSON/],
    [{ accounts: 'no' }, /did not parse \(1 issue/],
  ])('fails the whole pull on a bad window, asking no further: %#', async (bad, reason) => {
    const f = answering(bridgeAnswer(['t1']), bad, bridgeAnswer(['never']));
    const pulled = await pull(credential, wanted, { fetch: f.fetch, order: 'untilEmpty' });
    expect(pulled.ok).toBe(false);
    expect(!pulled.ok && pulled.reason).toMatch(reason);
    expect(pulled.requests).toBe(2);
  });

  it('asks every window before any answers, when not stopping at an empty one', async () => {
    const urls: string[] = [];
    const answers: ((r: Response) => void)[] = [];
    const held: typeof fetch = (input) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return new Promise((resolve) => answers.push(resolve));
    };
    const pulling = pull(credential, wanted, { fetch: held, order: 'together' });
    await Promise.resolve();
    expect(urls).toHaveLength(3);
    for (const answer of answers) answer(Response.json(bridgeAnswer([])));
    expect((await pulling).requests).toBe(3);
  });

  it('asks each window only once the one before has answered, in turn', async () => {
    const urls: string[] = [];
    const answers: ((r: Response) => void)[] = [];
    const held: typeof fetch = (input) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return new Promise((resolve) => answers.push(resolve));
    };
    const pulling = pull(credential, wanted, { fetch: held, order: 'inTurn' });
    for (let asked = 1; asked <= 3; asked++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(urls).toHaveLength(asked);
      answers[asked - 1]?.(Response.json(bridgeAnswer([])));
    }
    const pulled = await pulling;
    // An empty window does not stop it: that is untilEmpty's.
    expect(pulled.ok && pulled.covered).toHaveLength(3);
  });

  it('sends nothing once the budget is spent, and says so', async () => {
    let now = 0;
    const f = answering(bridgeAnswer(['t1']), bridgeAnswer(['never']));
    const timed: typeof fetch = (input, init) => {
      now += 60_000;
      return f.fetch(input, init);
    };
    const pulled = await pull(credential, wanted, {
      fetch: timed,
      order: 'inTurn',
      budgetMs: 50_000,
      clock: () => now,
    });
    expect(f.urls).toHaveLength(1);
    expect(pulled).toEqual({
      ok: false,
      reason: 'no time was left to ask for window 2',
      requests: 1,
    });
  });

  it('fails a pull asked at once when any window fails', async () => {
    const f = answering(bridgeAnswer(['t1']), new Response('', { status: 502 }), bridgeAnswer([]));
    const pulled = await pull(credential, wanted, { fetch: f.fetch, order: 'together' });
    expect(!pulled.ok && pulled.reason).toMatch(/HTTP 502/);
    expect(pulled.requests).toBe(3);
  });

  it('quotes what a refusal said, digits masked', async () => {
    const f = answering(new Response('Internal error: $1,234.56 (ref 42)', { status: 500 }));
    const pulled = await pull(credential, wanted.slice(0, 1), {
      fetch: f.fetch,
      order: 'untilEmpty',
    });
    expect(!pulled.ok && pulled.reason).toBe(
      'the Bridge answered HTTP 500: "Internal error: $#,###.## (ref ##)"',
    );
  });

  it('says a request that never answered, by the error’s name only', async () => {
    const f: typeof fetch = () => Promise.reject(new DOMException('slow', 'TimeoutError'));
    const pulled = await pull(credential, wanted, { fetch: f, order: 'together' });
    expect(!pulled.ok && pulled.reason).toBe('the Bridge did not answer (TimeoutError)');
  });
});
