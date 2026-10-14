import { describe, expect, it } from 'vitest';

import type {
  LinkAccount,
  Mapping,
  MonarchBalance,
  MonarchTransaction,
  Stored,
  Target,
} from './monarch.ts';
import {
  NOTHING_STORED,
  addStored,
  decisionOf,
  decisionSchema,
  describeUnready,
  lastFour,
  linkPair,
  mappingOf,
  parseCsv,
  parseMapping,
  parseStored,
  plan,
  proposeMapping,
  readBalances,
  readTarget,
  readTransactions,
  replay,
  sameTarget,
  strangers,
  targetOf,
  wroteNothing,
} from './monarch.ts';

const HEADER =
  'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id';

/** Shaped like Monarch's export of 24 Sep 2026, with values of its own. */
const transactionsCsv = [
  HEADER,
  '2026-09-20,Grocer,Groceries,Card (...1234),"GROCER, INC #12",,-45.10,,Nora,,101',
  '2026-09-21,,Transfer,Savings (...0391),"TRANSFER ""IN""",a note,100.00,Tag,Nora,Reviewed,102',
  '',
].join('\r\n');

describe('parseCsv', () => {
  it('reads quoted commas, doubled quotes and line breaks inside quotes', () => {
    expect(parseCsv('a,"b,c","say ""hi""","two\nlines"\n1,2,3,4')).toEqual([
      ['a', 'b,c', 'say "hi"', 'two\nlines'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('drops a byte-order mark and reads CRLF and a missing final newline', () => {
    expect(parseCsv('\uFEFFa,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a trailing empty field', () => {
    expect(parseCsv('a,\n')).toEqual([['a', '']]);
  });

  it('refuses a quote that is never closed', () => {
    expect(parseCsv('a,"b\n')).toBeNull();
  });
});

describe('readTransactions', () => {
  it('reads every column the store keeps, in minor units', () => {
    const read = readTransactions(transactionsCsv);
    expect(read).toEqual({
      ok: true,
      skipped: [],
      rows: [
        {
          account: 'Card (...1234)',
          id: '101',
          on_date: '2026-09-20',
          amount_minor: -4510,
          payee: 'Grocer',
          description: 'GROCER, INC #12',
          memo: null,
          category: 'Groceries',
          tagged: false,
        },
        {
          account: 'Savings (...0391)',
          id: '102',
          on_date: '2026-09-21',
          amount_minor: 10000,
          payee: null,
          description: 'TRANSFER "IN"',
          memo: 'a note',
          category: 'Transfer',
          tagged: true,
        },
      ],
    });
  });

  it('refuses a file missing a column it reads', () => {
    expect(readTransactions('Date,Amount\n2026-01-01,1.00')).toEqual({
      ok: false,
      reason: 'no Merchant, Category, Account, Original Statement, Notes, Tags, Id column',
    });
  });

  it('refuses an empty file and one cut short', () => {
    expect(readTransactions('')).toEqual({ ok: false, reason: 'the file is empty' });
    expect(readTransactions(`${HEADER}\n2026-01-01,"open`)).toEqual({
      ok: false,
      reason: 'a quoted field is never closed',
    });
  });

  it('skips a bad row by line and column, never quoting its amount', () => {
    const read = readTransactions(
      [
        HEADER,
        'yesterday,M,C,A,S,,-1.00,,N,,1',
        '2026-01-01,M,C,A,S,,-1.005,,N,,2',
        '2026-01-01,M,C,A,S,,-1.00,,N,,3',
        '2026-01-01,M,C,A,S,,-2.00,,N,,3',
      ].join('\n'),
    );
    expect(read.ok && read.skipped).toEqual([
      'line 2: Date unreadable',
      'line 3: Amount is not an exact dollar amount',
      'line 5: Id repeats an earlier row',
    ]);
    expect(read.ok && read.rows.map((r) => r.id)).toEqual(['3']);
    expect(JSON.stringify(read)).not.toContain('1.005');
  });

  it('allows one id on two accounts, since the store keys by account', () => {
    const read = readTransactions(
      [HEADER, '2026-01-01,M,C,A,S,,1.00,,N,,7', '2026-01-01,M,C,B,S,,1.00,,N,,7'].join('\n'),
    );
    expect(read.ok && read.rows.length).toBe(2);
  });
});

describe('readBalances', () => {
  it('reads one balance per account per day', () => {
    expect(readBalances('Date,Balance,Account\n2026-09-24,-12.30,Card (...1234)\n')).toEqual({
      ok: true,
      skipped: [],
      rows: [{ account: 'Card (...1234)', on_date: '2026-09-24', balance_minor: -1230 }],
    });
  });

  it('skips an unreadable row and a second one for a day', () => {
    const read = readBalances(
      [
        'Date,Balance,Account',
        '2026-09-24,1.00,',
        '2026-09-24,one,A',
        '2026-09-24,1.00,A',
        '2026-09-24,2.00,A',
      ].join('\n'),
    );
    expect(read.ok && read.skipped).toEqual([
      'line 2: Account unreadable',
      'line 3: Balance is not an exact dollar amount',
      'line 5: a second balance for the same account and day',
    ]);
  });

  it('refuses a file without the balance column', () => {
    expect(readBalances('Date,Account\n')).toEqual({ ok: false, reason: 'no Balance column' });
  });
});

describe('lastFour', () => {
  it("reads Monarch's and the Bridge's forms alike", () => {
    expect(lastFour('Savings (...0391)')).toBe('0391');
    expect(lastFour('Savings (0391)')).toBe('0391');
    expect(lastFour('Roth IRA *2505 (...2505) ')).toBe('2505');
  });

  it('reads no other digits as an account number', () => {
    expect(lastFour('42 Elm St Apt 7 Springfield IL 62704')).toBeNull();
    expect(lastFour('2024 Honda Civic Hybrid XLE')).toBeNull();
    expect(lastFour('Card (12345)')).toBeNull();
  });
});

describe('proposeMapping', () => {
  const dinora = [
    { source_id: 'ACT-1', institution: 'PSCU', name: 'Savings (0391)' },
    { source_id: 'ACT-2', institution: 'SUMMIT', name: 'Visa (5512)' },
    { source_id: 'ACT-3', institution: 'SUMMIT', name: 'Visa (3087)' },
    { source_id: 'ACT-4', institution: 'X', name: 'Twin (1111)' },
    { source_id: 'ACT-5', institution: 'Y', name: 'Twin (1111)' },
  ];

  it('links on four shared digits, and proposes the rest as history, unconfirmed', () => {
    expect(
      proposeMapping(
        [
          'Visa (...5512)',
          'Savings (...0391)',
          'Orchard Card',
          'Twin (...1111)',
          'Old (...3087)',
          'Also (...3087)',
        ],
        dinora,
      ),
    ).toEqual({
      confirmed: false,
      accounts: {
        'Also (...3087)': 'history',
        'Orchard Card': 'history',
        'Old (...3087)': 'history',
        'Savings (...0391)': { link: 'ACT-1', is: 'PSCU · Savings (0391)' },
        'Twin (...1111)': 'history',
        'Visa (...5512)': { link: 'ACT-2', is: 'SUMMIT · Visa (5512)' },
      },
    });
  });
});

describe('strangers', () => {
  it('names the accounts whose four digits no Dinora account has, and no other', () => {
    const dinora = [{ source_id: 'ACT-1', institution: 'PSCU', name: 'Savings (0391)' }];
    expect(
      strangers(['Loan (...3366)', 'Savings (...0391)', 'Orchard Card', 'Card (...0717)'], dinora),
    ).toEqual(['Card (...0717)', 'Loan (...3366)']);
  });

  it('names every numbered account when Dinora has pulled none', () => {
    expect(strangers(['Card (...0717)'], [])).toEqual(['Card (...0717)']);
  });
});

describe('describeUnready', () => {
  const link = { monarch_name: 'Card (...0717)', link: 'ACT-9' };

  it('says what each refusal is and what fixes it', () => {
    expect(describeUnready({ ...link, why: 'missing' })).toContain('which no bank account');
    expect(describeUnready({ ...link, why: 'deleted' })).toContain('mark it "skip"');
    expect(describeUnready({ ...link, why: 'currency' })).toContain('not in dollars');
    expect(describeUnready({ ...link, why: 'no_history' })).toContain('run the nightly pull');
  });

  it('tells a deleted history-only account to be skipped', () => {
    expect(describeUnready({ monarch_name: 'Robinhood', link: null, why: 'deleted' })).toBe(
      'Robinhood is "history" of an account deleted in Dinora: mark it "skip"',
    );
  });
});

describe('parseMapping', () => {
  it('reads the four kinds of target', () => {
    const read = parseMapping({
      confirmed: true,
      accounts: { A: { link: 'ACT-1' }, B: 'history', C: 'skip', D: { asset: 'home' } },
    });
    expect(read.ok).toBe(true);
  });

  it('refuses anything else', () => {
    expect(parseMapping({ confirmed: true, accounts: { A: 'import' } }).ok).toBe(false);
    expect(parseMapping({ confirmed: true, accounts: { A: { asset: 'boat' } } }).ok).toBe(false);
    expect(parseMapping({ confirmed: true, accounts: { A: { asset: 'crypto' } } }).ok).toBe(false);
    expect(parseMapping({ accounts: {} }).ok).toBe(false);
  });
});

describe('decisions (ACCT-18)', () => {
  const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  const targets: Target[] = [
    { link: 'ACT-1', is: 'Chase · Card (1234)' },
    { link: 'ACT-2' },
    'history',
    'skip',
    { asset: 'valuables' },
  ];

  it('stores each kind of target as a row and reads the same target back', () => {
    for (const t of targets) {
      const row = decisionOf('A', t, 'why', at(24));
      expect(decisionSchema.safeParse(row).success).toBe(true);
      expect(targetOf(row)).toEqual(t);
    }
    expect(decisionOf('A', { link: 'ACT-2' }, '', at(24))).toMatchObject({
      goes: 'link',
      link: 'ACT-2',
      link_is: null,
      asset_kind: null,
    });
  });

  it('reads no target from a row the file would have refused', () => {
    const row = decisionOf('A', 'skip', '', at(24));
    expect(targetOf({ ...row, goes: 'asset', asset_kind: 'crypto' })).toBeNull();
    expect(targetOf({ ...row, goes: 'link', link: null })).toBeNull();
  });

  it("adds up to each account's latest decision, whatever order the rows come in", () => {
    const mapped = mappingOf([
      decisionOf('B', 'history', '', at(26)),
      decisionOf('A', { link: 'ACT-1' }, '', at(26)),
      decisionOf('A', 'history', '', at(24)),
      decisionOf('B', 'skip', '', at(25)),
    ]);
    expect(mapped).toEqual({
      ok: true,
      mapping: { confirmed: true, accounts: { A: { link: 'ACT-1' }, B: 'history' } },
    });
  });

  it('names the account whose latest decision cannot be read', () => {
    const bad = { ...decisionOf('A', 'skip', '', at(26)), goes: 'asset' as const };
    expect(mappingOf([decisionOf('A', 'skip', '', at(24)), bad])).toEqual({ ok: false, bad: 'A' });
  });

  it('compares targets as stored, so a changed label is a changed decision', () => {
    expect(sameTarget(undefined, 'skip')).toBe(false);
    expect(sameTarget('skip', 'skip')).toBe(true);
    expect(sameTarget({ link: 'ACT-1' }, { link: 'ACT-1' })).toBe(true);
    expect(sameTarget({ link: 'ACT-1' }, { link: 'ACT-1', is: 'Card' })).toBe(false);
    expect(sameTarget({ asset: 'home' }, { asset: 'vehicle' })).toBe(false);
  });

  it('replays the copies oldest first, as a row wherever a file changed its mind', () => {
    const copy = (file: string, day: number, accounts: Mapping['accounts'], confirmed = true) => ({
      file,
      decided_at: at(day),
      mapping: { confirmed, accounts },
    });
    const rows = replay([
      copy('monarch-accounts.json', 26, { A: { link: 'ACT-1' }, B: 'skip', C: 'history' }),
      copy('monarch-accounts.old.json', 24, { A: 'history', B: 'skip', D: 'history' }),
      copy('monarch-accounts.draft.json', 25, { A: 'skip' }, false),
    ]);
    expect(rows.map((r) => [r.monarch_name, r.goes, r.decided_at, r.why])).toEqual([
      ['A', 'history', at(24), 'from monarch-accounts.old.json'],
      ['B', 'skip', at(24), 'from monarch-accounts.old.json'],
      ['D', 'history', at(24), 'from monarch-accounts.old.json'],
      ['A', 'link', at(26), 'from monarch-accounts.json'],
      ['C', 'history', at(26), 'from monarch-accounts.json'],
    ]);
    // D, left out of the later file, keeps its decision rather than losing it.
    const mapped = mappingOf(rows);
    expect(mapped.ok && mapped.mapping.accounts['D']).toBe('history');
  });

  it('reads --as, and nothing the file would not take', () => {
    expect(readTarget('history')).toBe('history');
    expect(readTarget('skip')).toBe('skip');
    expect(readTarget('asset:home')).toEqual({ asset: 'home' });
    expect(readTarget('link:ACT-1:x')).toEqual({ link: 'ACT-1:x' });
    for (const bad of ['', 'import', 'skip:x', 'asset:crypto', 'asset:', 'link:']) {
      expect(readTarget(bad)).toBeNull();
    }
  });
});

describe('plan', () => {
  const t = (account: string, id: string): MonarchTransaction => ({
    account,
    id,
    on_date: '2026-09-01',
    amount_minor: -100,
    payee: 'p',
    description: 'd',
    memo: null,
    category: null,
    tagged: false,
  });
  const b = (account: string, on_date: string, balance_minor: number): MonarchBalance => ({
    account,
    on_date,
    balance_minor,
  });
  const mapping: Mapping = {
    confirmed: true,
    accounts: {
      Card: { link: 'ACT-1', is: 'PSCU · Card' },
      Old: 'history',
      House: 'skip',
      Empty: 'history',
    },
  };

  it('makes one payload an account, history from its last day, skipping what is skipped', () => {
    const result = plan(
      mapping,
      [t('Card', '1'), t('Old', '2'), t('House', '3'), t('Empty', '4')],
      [
        b('Old', '2026-09-02', 700),
        b('Old', '2026-09-03', 800),
        b('Card', '2026-09-03', -5),
        b('House', '2026-09-03', 9),
      ],
    );
    expect(result).toEqual({
      ok: true,
      skipped: ['Empty: no balance in the file, so none to start it from'],
      assets: [],
      payloads: [
        {
          accounts: [
            {
              monarch_name: 'Card',
              link: 'ACT-1',
              currency: 'USD',
              balance_minor: -5,
              balance_on: '2026-09-03',
            },
          ],
          transactions: [
            {
              account: 'Card',
              id: '1',
              on_date: '2026-09-01',
              amount_minor: -100,
              payee: 'p',
              description: 'd',
              memo: null,
              category: null,
            },
          ],
          balances: [b('Card', '2026-09-03', -5)],
        },
        {
          accounts: [
            {
              monarch_name: 'Old',
              link: null,
              currency: 'USD',
              balance_minor: 800,
              balance_on: '2026-09-03',
            },
          ],
          transactions: [
            {
              account: 'Old',
              id: '2',
              on_date: '2026-09-01',
              amount_minor: -100,
              payee: 'p',
              description: 'd',
              memo: null,
              category: null,
            },
          ],
          balances: [b('Old', '2026-09-02', 700), b('Old', '2026-09-03', 800)],
        },
      ],
    });
  });

  it('links an account with no balances, since the bank supplies its balance', () => {
    const result = plan(mapping, [t('Card', '1')], []);
    expect(result.ok && result.payloads[0]?.accounts[0]?.link).toBe('ACT-1');
  });

  it('brings an asset in as the days its value changed, apart from the accounts', () => {
    const result = plan(
      { confirmed: true, accounts: { Card: { link: 'ACT-1' }, Home: { asset: 'home' } } },
      [],
      [
        b('Home', '2025-01-16', 100),
        b('Home', '2025-01-15', 100),
        b('Home', '2025-01-17', 120),
        b('Home', '2025-01-18', 120),
        b('Home', '2025-01-19', 100),
      ],
    );
    expect(result.ok && result.payloads).toHaveLength(0);
    expect(result.ok && result.assets).toEqual([
      {
        monarch_name: 'Home',
        kind: 'home',
        values: [
          { valued_on: '2025-01-15', amount_minor: 100 },
          { valued_on: '2025-01-17', amount_minor: 120 },
          { valued_on: '2025-01-19', amount_minor: 100 },
        ],
      },
    ]);
  });

  it('brings an asset in without its transactions, and says how many were left out', () => {
    const result = plan(
      { confirmed: true, accounts: { Jewelry: { asset: 'valuables' } } },
      [t('Jewelry', '1')],
      [b('Jewelry', '2025-01-15', 100), b('Jewelry', '2025-04-28', 150)],
    );
    expect(result).toEqual({
      ok: true,
      payloads: [],
      assets: [
        {
          monarch_name: 'Jewelry',
          kind: 'valuables',
          values: [
            { valued_on: '2025-01-15', amount_minor: 100 },
            { valued_on: '2025-04-28', amount_minor: 150 },
          ],
        },
      ],
      skipped: [
        'Jewelry: 1 transaction(s) left out, since an asset keeps values, not transactions',
      ],
    });
  });

  it('skips an asset with a value below zero, or with no value at all, and says why', () => {
    const result = plan(
      { confirmed: true, accounts: { Debt: { asset: 'home' }, Bare: { asset: 'vehicle' } } },
      [t('Bare', '1')],
      [b('Debt', '2025-01-15', -1)],
    );
    expect(result).toEqual({
      ok: true,
      payloads: [],
      assets: [],
      skipped: [
        'Bare: no value in the file, so nothing to bring in',
        'Debt: a value below zero, which no asset has',
      ],
    });
  });

  it('refuses an unconfirmed mapping', () => {
    expect(plan({ ...mapping, confirmed: false }, [], [])).toEqual({
      ok: false,
      reason: 'the account mapping is not confirmed yet',
    });
  });

  it('refuses an account the mapping does not mention', () => {
    expect(plan(mapping, [t('New', '1')], [b('Newer', '2026-09-01', 1)])).toEqual({
      ok: false,
      reason: 'the mapping does not say where New, Newer goes',
    });
  });
});

describe('what an import says', () => {
  const nothing: Stored = {
    accounts_added: 0,
    accounts_changed: 0,
    transactions_added: 0,
    transactions_changed: 0,
    transactions_left_to_bank: 12,
    days_added: 0,
    days_changed: 0,
    days_left_to_bank: 90,
    days_matched: 88,
    days_differed: 2,
  };

  it('parses the store answer', () => {
    expect(parseStored(nothing)).toEqual({ ok: true, value: nothing });
    expect(parseStored({ accounts_added: 1 }).ok).toBe(false);
  });

  it("adds two accounts' counts", () => {
    expect(addStored(NOTHING_STORED, nothing)).toEqual(nothing);
    expect(addStored(nothing, nothing).days_matched).toBe(176);
  });

  it('counts only what was written as writing', () => {
    expect(wroteNothing(nothing)).toBe(true);
    expect(wroteNothing({ ...nothing, days_changed: 1 })).toBe(false);
  });
});

describe('linkPair', () => {
  const MERIDIAN = 'MERIDIAN CORP 401(K) PLAN - **0717 (...0717)';
  const monarch: LinkAccount = {
    id: 'm1',
    source: 'monarch',
    source_id: MERIDIAN,
    institution: 'Monarch',
    name: MERIDIAN,
    currency: 'USD',
    deleted_at: null,
  };
  const bank: LinkAccount = {
    id: 'b1',
    source: 'simplefin',
    source_id: 'ACT-bc08',
    institution: 'Vanguard',
    name: 'MERIDIAN CORP 401(K) PLAN - 550717',
    currency: 'USD',
    deleted_at: null,
  };
  const mapping: Mapping = {
    confirmed: true,
    accounts: { [MERIDIAN]: 'history', 'Orchard Card': 'skip' },
  };

  it('links the Monarch name to the bank account, as the Meridian fix did by hand', () => {
    expect(linkPair(mapping, [monarch, bank], 'm1', 'b1')).toEqual({
      ok: true,
      mapping: {
        confirmed: true,
        accounts: {
          [MERIDIAN]: { link: 'ACT-bc08', is: `Vanguard · ${bank.name}` },
          'Orchard Card': 'skip',
        },
      },
    });
  });

  it('links a Plaid account too', () => {
    const plaid = { ...bank, source: 'plaid' };
    expect(linkPair(mapping, [monarch, plaid], 'm1', 'b1').ok).toBe(true);
  });

  const refused = (
    accounts: readonly LinkAccount[],
    ids: readonly [string, string] = ['m1', 'b1'],
    within: Mapping = mapping,
  ) => {
    const got = linkPair(within, accounts, ids[0], ids[1]);
    return got.ok ? null : got.reason;
  };

  it('refuses an id it cannot find', () => {
    expect(refused([bank])).toBe('no account m1');
    expect(refused([monarch])).toBe('no account b1');
  });

  it('refuses the two the wrong way round', () => {
    expect(refused([monarch, bank], ['b1', 'm1'])).toContain("is not Monarch's history");
  });

  it('refuses a pair already put together, or a bank account deleted', () => {
    expect(refused([{ ...monarch, deleted_at: '2026-09-26' }, bank])).toContain(
      'already put together',
    );
    expect(refused([monarch, { ...bank, deleted_at: '2026-09-26' }])).toContain('is deleted');
  });

  it('refuses two Monarch accounts, and two currencies', () => {
    expect(refused([monarch, { ...bank, source: 'monarch' }])).toContain('not an account a bank');
    expect(refused([monarch, { ...bank, currency: 'EUR' }])).toContain('in USD');
  });

  it('refuses a name the mapping lacks, or one she chose to skip', () => {
    expect(refused([{ ...monarch, source_id: 'Other' }, bank])).toBe('the mapping has no "Other"');
    expect(refused([{ ...monarch, source_id: 'Orchard Card' }, bank])).toBe(
      'the mapping has "Orchard Card" as "skip"',
    );
  });

  it('refuses a bank account another Monarch account already fills', () => {
    const within: Mapping = {
      confirmed: true,
      accounts: { [MERIDIAN]: 'history', 'Old plan (...0717)': { link: 'ACT-bc08' } },
    };
    expect(refused([monarch, bank], ['m1', 'b1'], within)).toContain(
      '"Old plan (...0717)" already links to',
    );
  });
});
