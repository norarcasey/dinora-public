import { describe, expect, it } from 'vitest';

import {
  READ_PRODUCTS,
  bankName,
  consentRequest,
  hostedUpdateRequest,
  hostedUrl,
  loginRequired,
  mergeSync,
  parseSyncPage,
  relinkAnswerSchema,
  transactionsItem,
  errorCode,
  institutionName,
  linkTokenRequest,
  parseInstitutions,
  plaidCode,
  plaidRows,
  readProduct,
  shape,
  signInAgain,
  updateTokenRequest,
  whichItem,
  withMask,
} from './plaid.ts';
import { wantsSignIn } from './signing-in.ts';

describe('readProduct', () => {
  it('allows the reads and refuses anything that can move money', () => {
    for (const p of READ_PRODUCTS) expect(readProduct(p)).toBe(p);
    for (const p of ['auth', 'transfer', 'payment_initiation', 'signal', 'identity', '']) {
      expect(readProduct(p)).toBeNull();
    }
  });

  it('is the only product a link token asks for', () => {
    expect(linkTokenRequest('liabilities', 'owner')).toEqual({
      client_name: 'Dinora',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: 'owner' },
      products: ['liabilities'],
    });
  });
});

describe('updateTokenRequest', () => {
  it('signs the item in again: its own token, and no product it could add', () => {
    const request = updateTokenRequest('access-sandbox-1', 'owner');
    expect(request).toEqual({
      client_name: 'Dinora',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: 'owner' },
      access_token: 'access-sandbox-1',
    });
    expect(request).not.toHaveProperty('products');
  });
});

describe('consentRequest', () => {
  it('is update mode asking consent to one read, and still names no product to link', () => {
    const request = consentRequest('access-production-2', 'owner', 'transactions');
    expect(request).toEqual({
      ...updateTokenRequest('access-production-2', 'owner'),
      additional_consented_products: ['transactions'],
    });
    expect(request).not.toHaveProperty('products');
  });
});

describe('hostedUpdateRequest', () => {
  it('is update mode as Hosted Link, still with no product it could add', () => {
    const request = hostedUpdateRequest('access-production-1', 'owner');
    expect(request).toEqual({
      client_name: 'Dinora',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: 'owner' },
      access_token: 'access-production-1',
      hosted_link: {},
    });
    expect(request).not.toHaveProperty('products');
  });
});

describe('hostedUrl', () => {
  it("is Plaid's https address, or null", () => {
    expect(hostedUrl({ hosted_link_url: 'https://secure.plaid.com/hl/x', link_token: 't' })).toBe(
      'https://secure.plaid.com/hl/x',
    );
    expect(hostedUrl({ link_token: 't' })).toBeNull();
    expect(hostedUrl({ hosted_link_url: 'javascript:alert(1)' })).toBeNull();
    expect(hostedUrl({ hosted_link_url: 'http://secure.plaid.com/hl/x' })).toBeNull();
  });
});

describe('loginRequired', () => {
  it('reads the error Plaid keeps on the item', () => {
    const login = { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' };
    expect(loginRequired({ item: { error: login } })).toBe(true);
    expect(loginRequired({ item: { error: { error_code: 'INSTITUTION_DOWN' } } })).toBe(false);
    expect(loginRequired({ item: { error: null } })).toBe(false);
    expect(loginRequired({ item: {} })).toBe(false);
    expect(loginRequired(null)).toBe(false);
  });
});

describe('wantsSignIn', () => {
  it('knows the words signInAgain writes, and nothing else', () => {
    expect(wantsSignIn(signInAgain({ item: { institution_name: 'Harbor Mortgage' } }, 0))).toBe(
      true,
    );
    expect(wantsSignIn(signInAgain(null, 1))).toBe(true);
    expect(wantsSignIn('item 1: Plaid refused /accounts/get: HTTP 500, API_ERROR/x')).toBe(false);
    expect(wantsSignIn('')).toBe(false);
  });
});

describe('bankName', () => {
  it('is the name, or the item by its place', () => {
    expect(bankName({ item: { institution_name: 'Lakeside Bank' } }, 1)).toBe('Lakeside Bank');
    expect(bankName({ item: {} }, 1)).toBe("item 2's bank");
  });
});

describe('relinkAnswerSchema', () => {
  it('takes only an https address to open', () => {
    const open = { kind: 'open', bank: 'Harbor Mortgage', url: 'https://secure.plaid.com/hl/x' };
    expect(relinkAnswerSchema.safeParse(open).success).toBe(true);
    expect(relinkAnswerSchema.safeParse({ ...open, url: 'javascript:alert(1)' }).success).toBe(
      false,
    );
  });

  it('carries a reason with a read that failed', () => {
    expect(relinkAnswerSchema.safeParse({ kind: 'read' }).success).toBe(true);
    expect(relinkAnswerSchema.safeParse({ kind: 'failed' }).success).toBe(false);
    expect(relinkAnswerSchema.safeParse({ kind: 'failed', reason: 'x' }).success).toBe(true);
  });
});

describe('parseInstitutions', () => {
  it('keeps the read products each supports, and whether it links by OAuth', () => {
    const parsed = parseInstitutions({
      institutions: [
        {
          institution_id: 'ins_1',
          name: 'Harbor Mortgage',
          products: ['auth', 'balance', 'liabilities', 'transactions'],
          oauth: false,
          country_codes: ['US'],
        },
        { institution_id: 'ins_2', name: 'Fabrikam', products: ['investments'] },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      value: [
        {
          id: 'ins_1',
          name: 'Harbor Mortgage',
          reads: ['liabilities', 'transactions'],
          oauth: false,
        },
        { id: 'ins_2', name: 'Fabrikam', reads: ['investments'], oauth: false },
      ],
    });
  });

  it('refuses an answer without institutions', () => {
    expect(parseInstitutions({}).ok).toBe(false);
  });
});

const mortgageAccount = {
  account_id: 'a1',
  type: 'loan',
  subtype: 'mortgage',
  balances: { current: 312000.5, available: null, iso_currency_code: 'USD' },
};

const retirementAccount = {
  account_id: 'a2',
  type: 'investment',
  subtype: '401k',
  balances: {
    current: 1000,
    available: 0,
    iso_currency_code: null,
    unofficial_currency_code: 'USD',
    last_updated_datetime: '2026-09-25T00:00:00Z',
  },
};

describe('shape', () => {
  it('says what a mortgage sends by sign and field name, never by amount', () => {
    const shaped = shape({
      accounts: { accounts: [mortgageAccount], item: { institution_id: 'ins_1' } },
      liabilities: {
        liabilities: {
          mortgage: [
            { account_id: 'a1', interest_rate: { percentage: 6.5 }, escrow_balance: null },
            { account_id: 'other', origination_date: '2020-01-01' },
          ],
        },
      },
      holdings: null,
    });
    expect(shaped).toEqual({
      ok: true,
      value: [
        {
          type: 'loan',
          subtype: 'mortgage',
          currency: 'USD',
          current: 'positive',
          available: 'absent',
          dated: false,
          holdings: 0,
          withCost: 0,
          mortgage: 'account_id interest_rate',
        },
      ],
    });
    expect(JSON.stringify(shaped)).not.toMatch(/312000|6\.5/);
  });

  it('counts holdings, and those with a cost basis', () => {
    const shaped = shape({
      accounts: {
        accounts: [retirementAccount, { ...mortgageAccount, subtype: null }],
        item: {},
      },
      liabilities: null,
      holdings: {
        holdings: [
          { account_id: 'a2', cost_basis: 10 },
          { account_id: 'a2', cost_basis: null },
          { account_id: 'a2' },
        ],
      },
    });
    expect(shaped.ok && shaped.value[0]).toMatchObject({
      currency: 'USD',
      current: 'positive',
      available: 'zero',
      dated: true,
      holdings: 3,
      withCost: 1,
      mortgage: '',
    });
    expect(shaped.ok && shaped.value[1]).toMatchObject({ subtype: '', currency: 'USD' });
  });

  it('reads a negative balance and a missing currency', () => {
    const shaped = shape({
      accounts: {
        accounts: [
          {
            ...mortgageAccount,
            balances: { current: -1, available: null, iso_currency_code: null },
          },
        ],
        item: {},
      },
      liabilities: null,
      holdings: null,
    });
    expect(shaped.ok && shaped.value[0]).toMatchObject({ current: 'negative', currency: '' });
  });

  it('counts the issues when any answer does not parse', () => {
    const accounts = { accounts: [], item: {} };
    expect(shape({ accounts: {}, liabilities: null, holdings: null })).toEqual({
      ok: false,
      issues: 2,
    });
    expect(shape({ accounts, liabilities: {}, holdings: null })).toEqual({
      ok: false,
      issues: 1,
    });
    expect(shape({ accounts, liabilities: null, holdings: { holdings: 1 } })).toEqual({
      ok: false,
      issues: 1,
    });
  });
});

describe('errorCode', () => {
  it("is Plaid's type and code, or null", () => {
    expect(errorCode({ error_type: 'A', error_code: 'B', error_message: 'x' })).toBe('A/B');
    expect(errorCode({ error: 'x' })).toBeNull();
  });

  it('says what was wrong with the request, and nothing else Plaid says', () => {
    expect(
      errorCode({
        error_type: 'INVALID_REQUEST',
        error_code: 'INVALID_FIELD',
        error_message: 'products must be a non-empty array',
      }),
    ).toBe('INVALID_REQUEST/INVALID_FIELD (products must be a non-empty array)');
    expect(
      errorCode({ error_type: 'ITEM_ERROR', error_code: 'X', error_message: 'Checking 1234' }),
    ).toBe('ITEM_ERROR/X');
  });
});

describe('plaidCode', () => {
  it("is Plaid's code alone, or null", () => {
    expect(plaidCode({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' })).toBe(
      'ITEM_LOGIN_REQUIRED',
    );
    expect(plaidCode({})).toBeNull();
  });
});

describe('signInAgain', () => {
  it('names the bank from /item/get', () => {
    expect(signInAgain({ item: { institution_name: 'Harbor Mortgage' } }, 0)).toBe(
      'Harbor Mortgage needs signing in again',
    );
  });

  it('falls back to the item by its place when Plaid gave no name', () => {
    expect(signInAgain({ item: { institution_name: null } }, 1)).toBe(
      "item 2's bank needs signing in again",
    );
    expect(signInAgain(null, 0)).toBe("item 1's bank needs signing in again");
  });
});

describe('institutionName', () => {
  it("is the bank's name, or null when Plaid gave none", () => {
    expect(institutionName({ item: { institution_name: 'Harbor Mortgage' } })).toBe(
      'Harbor Mortgage',
    );
    expect(institutionName({ item: { institution_name: '' } })).toBeNull();
    expect(institutionName({ item: {} })).toBeNull();
    expect(institutionName('x')).toBeNull();
  });
});

describe('whichItem', () => {
  const names = ['Harbor Mortgage', null, 'Fabrikam'];

  it('finds the bank as the home screen names it, in any case', () => {
    expect(whichItem('Harbor Mortgage', names)).toEqual({ ok: true, index: 0 });
    expect(whichItem('  fabrikam ', names)).toEqual({ ok: true, index: 2 });
  });

  it('finds an item by its place, as the home screen says it when there is no name', () => {
    expect(whichItem('2', names)).toEqual({ ok: true, index: 1 });
  });

  it('refuses a place past the end, and lists what there is', () => {
    expect(whichItem('4', names)).toEqual({
      ok: false,
      reason: 'no item is "4"; say one of: 1 Harbor Mortgage, 2 (no name), 3 Fabrikam',
    });
    expect(whichItem('0', names).ok).toBe(false);
  });

  it('refuses a name two items share, rather than guess', () => {
    const twice = whichItem('PSCU', ['PSCU', 'pscu']);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.reason).toMatch(/^2 items are "PSCU"/);
  });

  it('refuses a name nothing has', () => {
    expect(whichItem('Chase', names).ok).toBe(false);
  });
});

describe('plaidRows', () => {
  const AT = '2026-09-26T09:00:00.000Z';
  const item = (name: string | null) => ({ item: { institution_name: name } });
  const account = (id: string, type: string, current: number | null, extra = {}) => ({
    account_id: id,
    name: `Account ${id}`,
    type,
    subtype: null,
    balances: { current, available: null, iso_currency_code: 'USD' },
    ...extra,
  });

  it("turns the lender's figure into the cardholder's, and keeps deposits as they are", () => {
    const got = plaidRows(
      [
        {
          place: 0,
          item: item('Harbor Mortgage'),
          accounts: { accounts: [account('m', 'loan', 312000.5)] },
        },
        {
          place: 1,
          item: item('Lakeside Bank'),
          accounts: {
            accounts: [
              account('s', 'depository', 1234.56, {
                balances: { current: 1234.56, available: 1200.1, iso_currency_code: 'USD' },
              }),
              account('c', 'credit', 0.1),
            ],
          },
        },
      ],
      AT,
      [],
    );
    expect(got).toEqual({
      ok: true,
      rows: {
        accounts: [
          {
            source_id: 'm',
            institution: 'Harbor Mortgage',
            name: 'Account m',
            currency: 'USD',
            balance_minor: -31200050,
            available_minor: null,
            balance_at: AT,
            holdings: 0,
          },
          expect.objectContaining({
            source_id: 's',
            balance_minor: 123456,
            available_minor: 120010,
          }),
          expect.objectContaining({ source_id: 'c', balance_minor: -10, available_minor: null }),
        ],
        transactions: [],
        skipped: [],
        errors: [],
        partial: [],
      },
      removed: [],
      cursors: [],
    });
  });

  it('puts the mask after the name, as the Bridge does, so a Monarch copy can be found', () => {
    const got = plaidRows(
      [
        {
          place: 0,
          item: item('Gemini'),
          accounts: {
            accounts: [
              account('c', 'credit', 1, { name: 'Gemini Credit Card', mask: '4821' }),
              account('d', 'depository', 1, { name: 'Savings 0391', mask: '0391' }),
              account('e', 'depository', 1, { mask: null }),
            ],
          },
        },
      ],
      AT,
      [],
    );
    expect(got.ok && got.rows.accounts.map((a) => a.name)).toEqual([
      'Gemini Credit Card (4821)',
      'Savings 0391',
      'Account e',
    ]);
  });

  it('keeps a paid-off loan at zero, not minus zero', () => {
    const got = plaidRows(
      [{ place: 0, item: item(null), accounts: { accounts: [account('m', 'loan', 0)] } }],
      AT,
      [],
    );
    expect(got.ok && Object.is(got.rows.accounts[0]?.balance_minor, 0)).toBe(true);
    expect(got.ok && got.rows.accounts[0]?.institution).toBe('');
  });

  it('skips an account it cannot read exactly, and says why without an amount', () => {
    const got = plaidRows(
      [
        {
          place: 0,
          item: item('Bank'),
          accounts: {
            accounts: [
              account('a', 'depository', 1.005),
              account('b', 'depository', null),
              account('c', 'depository', 1, {
                balances: { current: 1, available: null, iso_currency_code: null },
              }),
            ],
          },
        },
      ],
      AT,
      [],
    );
    expect(got.ok && got.rows.accounts).toEqual([]);
    expect(got.ok && got.rows.skipped).toEqual([
      {
        kind: 'account',
        account: 'a',
        label: "Bank's Account a",
        why: 'its balance is not an exact USD amount',
      },
      {
        kind: 'account',
        account: 'b',
        label: "Bank's Account b",
        why: 'it has no current balance',
      },
      {
        kind: 'account',
        account: 'c',
        label: "Bank's Account c",
        why: 'its currency is not an ISO 4217 code',
      },
    ]);
  });

  it('leaves out an available balance it cannot read exactly', () => {
    const got = plaidRows(
      [
        {
          place: 0,
          item: item('Bank'),
          accounts: {
            accounts: [
              account('a', 'depository', 1, {
                balances: { current: 1, available: 0.001, iso_currency_code: 'USD' },
              }),
            ],
          },
        },
      ],
      AT,
      [],
    );
    expect(got.ok && got.rows.accounts[0]?.available_minor).toBeNull();
  });

  it('fails the lot when any item does not parse, naming it by its place', () => {
    expect(plaidRows([{ place: 2, item: {}, accounts: { accounts: [] } }], AT, [])).toEqual({
      ok: false,
      reason: "item 3's answer did not parse",
    });
    expect(plaidRows([{ place: 0, item: item('x'), accounts: {} }], AT, []).ok).toBe(false);
  });

  it('carries the banks left out for signing in as errors, so the detail names them', () => {
    const got = plaidRows([], AT, ['Harbor Mortgage needs signing in again']);
    expect(got.ok && got.rows.errors).toEqual(['Harbor Mortgage needs signing in again']);
  });
});

describe('transactionsItem', () => {
  const item = (fields: object) => ({ item: { item_id: 'I', ...fields } });

  it('is the item id when Transactions is billed or consented to', () => {
    expect(transactionsItem(item({ products: ['transactions'] }))).toBe('I');
    expect(transactionsItem(item({ billed_products: ['transactions'] }))).toBe('I');
    expect(
      transactionsItem(item({ products: ['liabilities'], consented_products: ['transactions'] })),
    ).toBe('I');
  });

  it('is null for an item linked for something else, since asking would add the product', () => {
    expect(transactionsItem(item({ products: ['liabilities'] }))).toBeNull();
    expect(transactionsItem(item({}))).toBeNull();
    expect(transactionsItem({ item: {} })).toBeNull();
  });
});

/** A transaction as Plaid's /transactions/sync sends one: positive is money out. */
function plaidTx(id: string, amount: number, extra: object = {}) {
  return {
    transaction_id: id,
    account_id: 'card',
    amount,
    iso_currency_code: 'USD',
    date: '2026-09-27',
    authorized_date: '2026-09-26',
    name: 'SQ *COFFEE',
    merchant_name: 'Coffee',
    pending: false,
    ...extra,
  };
}

function page(fields: object = {}) {
  return { added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false, ...fields };
}

describe('parseSyncPage', () => {
  it("reads Plaid's page and drops what Dinora does not keep", () => {
    const got = parseSyncPage(
      page({ added: [{ ...plaidTx('t', 1), category: ['Food'] }], request_id: 'r' }),
    );
    expect(got.ok && got.value.added[0]).toEqual(plaidTx('t', 1));
  });

  it('refuses a transaction whose date is not a date', () => {
    expect(parseSyncPage(page({ added: [plaidTx('t', 1, { date: '27/09/2026' })] })).ok).toBe(
      false,
    );
  });
});

describe('mergeSync', () => {
  const read = (fields: object) => {
    const parsed = parseSyncPage(page(fields));
    if (!parsed.ok) throw new Error('page did not parse');
    return parsed.value;
  };

  it('keeps each transaction as it last stood, and the last cursor', () => {
    const got = mergeSync('I', [
      read({ added: [plaidTx('a', 1), plaidTx('b', 2)], next_cursor: 'c1', has_more: true }),
      read({ modified: [plaidTx('a', 3)], removed: [{ transaction_id: 'b' }], next_cursor: 'c2' }),
    ]);
    expect(got).toEqual({
      item: 'I',
      cursor: 'c2',
      transactions: [plaidTx('a', 3)],
      removed: ['b'],
    });
  });

  it('un-removes one that comes back on a later page', () => {
    const got = mergeSync('I', [
      read({ removed: [{ transaction_id: 'a' }] }),
      read({ added: [plaidTx('a', 1)] }),
    ]);
    expect(got.removed).toEqual([]);
    expect(got.transactions).toHaveLength(1);
  });

  it('has no cursor when there were no pages', () => {
    expect(mergeSync('I', [])).toEqual({ item: 'I', cursor: '', transactions: [], removed: [] });
  });
});

describe('plaidRows with transactions (BANK-14)', () => {
  const AT = '2026-09-27T09:00:00.000Z';
  const gemini = {
    place: 0,
    item: { item: { institution_name: 'Gemini' } },
    accounts: {
      accounts: [
        {
          account_id: 'card',
          name: 'Gemini Credit Card',
          type: 'credit',
          subtype: 'credit card',
          balances: { current: 120.5, available: 4879.5, iso_currency_code: 'USD' },
        },
      ],
    },
  };
  const synced = (transactions: object[], removed: string[] = [], cursor = 'c2') => {
    const parsed = parseSyncPage(page({ added: transactions }));
    if (!parsed.ok) throw new Error('page did not parse');
    return new Map([[0, { ...mergeSync('I', [parsed.value]), removed, cursor }]]);
  };

  it("turns Plaid's sign into the cardholder's: a charge negative, a refund positive", () => {
    const got = plaidRows(
      [gemini],
      AT,
      [],
      synced([plaidTx('charge', 12.34), plaidTx('refund', -25.5, { name: 'REFUND' })]),
    );
    expect(got.ok && got.rows.transactions).toEqual([
      {
        account_source_id: 'card',
        source_id: 'charge',
        posted_at: '2026-09-27T12:00:00.000Z',
        transacted_at: '2026-09-26T12:00:00.000Z',
        amount_minor: -1234,
        description: 'SQ *COFFEE',
        payee: 'Coffee',
        memo: null,
        pending: false,
      },
      expect.objectContaining({ source_id: 'refund', amount_minor: 2550, description: 'REFUND' }),
    ]);
    expect(got.ok && got.cursors).toEqual([{ item: 'I', cursor: 'c2' }]);
  });

  it('keeps a pending one undated as posted, dated when it happened', () => {
    const got = plaidRows(
      [gemini],
      AT,
      [],
      synced([
        plaidTx('p', 5, { pending: true, authorized_date: null, merchant_name: null }),
        plaidTx('q', 0, { authorized_date: null }),
      ]),
    );
    expect(got.ok && got.rows.transactions).toEqual([
      expect.objectContaining({
        source_id: 'p',
        posted_at: null,
        transacted_at: '2026-09-27T12:00:00.000Z',
        payee: null,
        pending: true,
      }),
      expect.objectContaining({ source_id: 'q', transacted_at: null, amount_minor: 0 }),
    ]);
    expect(got.ok && Object.is(got.rows.transactions[1]?.amount_minor, 0)).toBe(true);
  });

  it('carries what Plaid removed, to be marked dropped', () => {
    const got = plaidRows([gemini], AT, [], synced([], ['pending-1']));
    expect(got.ok && got.removed).toEqual(['pending-1']);
  });

  it('skips a transaction it cannot read exactly, and holds the cursor so it is asked again', () => {
    const got = plaidRows(
      [gemini],
      AT,
      [],
      synced([
        plaidTx('ok', 1),
        plaidTx('odd', 1.005),
        plaidTx('x', 1, { iso_currency_code: null }),
      ]),
    );
    expect(got.ok && got.rows.transactions.map((t) => t.source_id)).toEqual(['ok']);
    expect(got.ok && got.rows.skipped).toEqual([
      {
        kind: 'transaction',
        transaction: 'odd',
        account: 'card',
        label: "Gemini's Gemini Credit Card",
        why: 'its amount or currency could not be read',
      },
      expect.objectContaining({ transaction: 'x' }),
    ]);
    expect(got.ok && got.rows.partial).toEqual(['card']);
    expect(got.ok && got.cursors).toEqual([]);
  });

  it('holds the cursor when the account itself was skipped, and stores none of its rows', () => {
    const noBalance = {
      ...gemini,
      accounts: {
        accounts: [
          {
            ...gemini.accounts.accounts[0],
            balances: { current: null, available: null, iso_currency_code: 'USD' },
          },
        ],
      },
    };
    const got = plaidRows([noBalance], AT, [], synced([plaidTx('a', 1)]));
    expect(got.ok && got.rows.transactions).toEqual([]);
    expect(got.ok && got.cursors).toEqual([]);
  });

  it('saves no cursor Plaid did not give', () => {
    const got = plaidRows([gemini], AT, [], synced([], [], ''));
    expect(got.ok && got.cursors).toEqual([]);
  });
});

describe('withMask', () => {
  it('puts the digits after the name, once', () => {
    expect(withMask('Gemini Credit Card', '4821')).toBe('Gemini Credit Card (4821)');
    expect(withMask('Gemini Credit Card (4821)', '4821')).toBe('Gemini Credit Card (4821)');
    expect(withMask('  ', '4821')).toBe('(4821)');
  });

  it('leaves a name alone when Plaid sent no mask', () => {
    expect(withMask('Mortgage', null)).toBe('Mortgage');
    expect(withMask('Mortgage', undefined)).toBe('Mortgage');
    expect(withMask('Mortgage', ' ')).toBe('Mortgage');
  });
});
