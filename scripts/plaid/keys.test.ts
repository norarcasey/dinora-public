import { describe, expect, it } from 'vitest';

import { items, nextItem, readCredentials, readKeys, relinkArgs } from './keys.ts';

const ID = 'a'.repeat(24);
const SECRET = 'b'.repeat(30);
const FILE = '/repo/.env.plaid';

describe('readCredentials', () => {
  it('reads KEY=value lines, passing over comments, blanks and lines with no key', () => {
    const found = readCredentials(
      `# Plaid keys, kept 2026-09-25. Credentials: never commit, never print.\n` +
        `PLAID_CLIENT_ID=${ID}\n\n=orphan\nnot a line\nPLAID_SECRET=${SECRET}  \n`,
    );
    expect([...found]).toEqual([
      ['PLAID_CLIENT_ID', ID],
      ['PLAID_SECRET', SECRET],
    ]);
  });

  it('keeps an = inside a value', () => {
    expect(readCredentials('K=a=b').get('K')).toBe('a=b');
  });

  it('takes the last of a key written twice', () => {
    expect(readCredentials('K=1\nK=2\n').get('K')).toBe('2');
  });
});

describe('readKeys', () => {
  const keys = (env: string) =>
    new Map([
      ['PLAID_CLIENT_ID', ID],
      ['PLAID_SECRET', SECRET],
      ['PLAID_ENV', env],
    ]);

  it("reads keys in Plaid's form for sandbox or production", () => {
    expect(readKeys(keys('production'), FILE)).toEqual({
      ok: true,
      value: { clientId: ID, secret: SECRET, env: 'production' },
    });
  });

  it('refuses a file missing a key or naming another environment, and names only the file', () => {
    const missing = new Map([['PLAID_CLIENT_ID', ID]]);
    expect(readKeys(missing, FILE)).toEqual({
      ok: false,
      reason: `no keys in ${FILE}. Keep them first: pnpm plaid:keys`,
    });
    expect(readKeys(keys('development'), FILE).ok).toBe(false);
  });

  it('refuses keys carrying what a paste left on them, without printing them', () => {
    const pasted = new Map([...keys('sandbox'), ['PLAID_SECRET', `${SECRET}\\`]]);
    const read = readKeys(pasted, FILE);
    expect(read).toEqual({ ok: false, reason: `the keys in ${FILE} are not Plaid's form.` });
  });
});

describe('items', () => {
  it('reads each linked item as its product and token, in the order they were kept', () => {
    const found = readCredentials(
      `PLAID_CLIENT_ID=${ID}\nPLAID_ITEM_1=liabilities access-1\nPLAID_ITEM_2=investments access-2\n`,
    );
    expect(items(found)).toEqual([
      { product: 'liabilities', token: 'access-1' },
      { product: 'investments', token: 'access-2' },
    ]);
  });

  it('is not misled by a key that only starts like an item', () => {
    const found = readCredentials('PLAID_ITEM_NOTE=liabilities x\nPLAID_ITEM_1=liabilities a\n');
    expect(items(found)).toEqual([{ product: 'liabilities', token: 'a' }]);
  });
});

describe('nextItem', () => {
  it('numbers the first item 1', () => {
    expect(nextItem(new Map())).toBe(1);
  });

  it('numbers past the highest, so an item removed by hand never hides another', () => {
    const found = readCredentials('PLAID_ITEM_1=liabilities a\nPLAID_ITEM_3=investments c\n');
    expect(items(found)).toHaveLength(2);
    expect(nextItem(found)).toBe(4);
  });
});

describe('relinkArgs', () => {
  it('reads the bank in any words', () => {
    expect(relinkArgs(['Harbor', 'Mortgage'])).toEqual({
      ok: true,
      value: { wanted: 'Harbor Mortgage', adding: null },
    });
    expect(relinkArgs([])).toEqual({ ok: true, value: { wanted: '', adding: null } });
  });

  it('takes --add and its product out of the bank wherever it is', () => {
    expect(relinkArgs(['--add', 'transactions', 'Harbor', 'Mortgage'])).toEqual({
      ok: true,
      value: { wanted: 'Harbor Mortgage', adding: 'transactions' },
    });
    expect(relinkArgs(['2', '--add', 'investments'])).toEqual({
      ok: true,
      value: { wanted: '2', adding: 'investments' },
    });
  });

  it('refuses --add with no read product, rather than relinking without it', () => {
    expect(relinkArgs(['2', '--add']).ok).toBe(false);
    expect(relinkArgs(['2', '--add', 'auth']).ok).toBe(false);
  });
});
