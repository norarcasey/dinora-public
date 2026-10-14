import { describe, expect, it } from 'vitest';

import { wantsSignIn } from './signing-in.ts';
import type { AccountSet, Rows, Skip } from './simplefin.ts';
import {
  NIGHTLY_WINDOWS,
  accountLabel,
  combine,
  detail,
  dropsFrom,
  historyFrom,
  parseAccountSet,
  report,
  toRows,
  windows,
} from './simplefin.ts';

/** Shaped like the Bridge's demo on 24 Sep 2026, with values of its own. */
const demo = {
  errlist: [
    { code: 'gen.api', msg: 'Requested date range exceeds limit of 90 days and was capped.' },
  ],
  connections: [
    {
      conn_id: 'CON-1',
      name: 'Card Co',
      org_id: 'org.card',
      org_name: 'Card Company',
      org_url: 'https://card.example.test',
      sfin_url: 'https://bridge.example.test/simplefin',
    },
  ],
  accounts: [
    {
      id: 'ACT-1',
      name: 'Rewards Card',
      conn_id: 'CON-1',
      currency: 'USD',
      balance: '-1234.56',
      'available-balance': '8765.44',
      'balance-date': 1790294400,
      transactions: [
        {
          id: 'T1',
          posted: 1782633600,
          amount: '-05.50',
          description: 'Coffee',
          payee: 'Cafe',
          memo: 'CAFE #1',
          transacted_at: 1782600000,
          mcc: null,
        },
        { id: 'T2', posted: 0, amount: '20.00', description: 'Refund', pending: true },
        { id: 'T3', posted: 1782700000, amount: '1.005', description: 'Odd' },
      ],
      holdings: [],
    },
    {
      id: 'ACT-2',
      name: 'Points',
      conn_id: 'CON-1',
      currency: 'https://card.example.test/points',
      balance: '100',
      'balance-date': 1790294400,
    },
    {
      id: 'ACT-3',
      name: 'Broken',
      conn_id: 'CON-X',
      currency: 'USD',
      balance: 'n/a',
      'balance-date': 1790294400,
    },
    {
      id: 'ACT-4',
      name: 'Brokerage',
      conn_id: 'CON-X',
      currency: 'USD',
      balance: '0.00',
      'available-balance': 'n/a',
      'balance-date': 1790294400,
      holdings: [{ symbol: 'X' }, { symbol: 'Y' }],
    },
  ],
};

function parsed(input: unknown): AccountSet {
  const result = parseAccountSet(input);
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.value;
}

describe('parseAccountSet', () => {
  it('reads the demo shape and drops what Dinora does not keep', () => {
    const set = parsed(demo);
    expect(set.accounts).toHaveLength(4);
    expect(set.accounts[0]?.transactions[0]).not.toHaveProperty('mcc');
    expect(set.accounts[1]?.transactions).toEqual([]);
  });

  it('defaults errlist and connections, which version 1 does not send', () => {
    const set = parsed({ accounts: [] });
    expect(set.errlist).toEqual([]);
    expect(set.connections).toEqual([]);
  });

  it('refuses a set with no accounts array, and says where', () => {
    const result = parseAccountSet({ errors: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues).toEqual([expect.stringContaining('accounts')]);
  });
});

describe('toRows', () => {
  const rows = toRows(parsed(demo));

  it('keeps readable accounts with amounts in cents and the bank’s own balance date', () => {
    expect(rows.accounts.map((a) => a.source_id)).toEqual(['ACT-1', 'ACT-4']);
    expect(rows.accounts[0]).toEqual({
      source_id: 'ACT-1',
      institution: 'Card Company',
      name: 'Rewards Card',
      currency: 'USD',
      balance_minor: -123456,
      available_minor: 876544,
      balance_at: '2026-09-25T00:00:00.000Z',
      holdings: 0,
    });
  });

  it('keeps an account whose available balance is unreadable, without it', () => {
    expect(rows.accounts[1]).toMatchObject({ institution: '', available_minor: null });
  });

  it('reads pending from the flag or from posted being 0', () => {
    expect(rows.transactions).toEqual([
      {
        account_source_id: 'ACT-1',
        source_id: 'T1',
        posted_at: '2026-06-28T08:00:00.000Z',
        transacted_at: '2026-06-27T22:40:00.000Z',
        amount_minor: -550,
        description: 'Coffee',
        payee: 'Cafe',
        memo: 'CAFE #1',
        pending: false,
      },
      {
        account_source_id: 'ACT-1',
        source_id: 'T2',
        posted_at: null,
        transacted_at: null,
        amount_minor: 2000,
        description: 'Refund',
        payee: null,
        memo: null,
        pending: true,
      },
    ]);
  });

  it('says what it skipped, by bank and name, without quoting an amount', () => {
    expect(rows.skipped).toEqual([
      {
        kind: 'transaction',
        account: 'ACT-1',
        label: "Card Company's Rewards Card",
        transaction: 'T3',
        why: 'its amount is not an exact amount',
      },
      {
        kind: 'account',
        account: 'ACT-2',
        label: "Card Company's Points",
        why: 'its currency is not an ISO 4217 code',
      },
      {
        kind: 'account',
        account: 'ACT-3',
        label: 'Broken',
        why: 'its balance is not an exact USD amount',
      },
      {
        kind: 'available',
        account: 'ACT-4',
        label: 'Brokerage',
        why: 'unreadable, kept as none',
      },
    ]);
    expect(JSON.stringify(rows.skipped)).not.toMatch(/1\.005|n\/a|Cafe/);
  });

  it('reads a blank currency as dollars, as Vanguard sends its 401(k)', () => {
    const vanguard = toRows(
      parsed({
        connections: [{ conn_id: 'CON-V', name: 'Vanguard' }],
        accounts: [
          {
            id: 'ACT-V',
            name: '401(K) PLAN',
            conn_id: 'CON-V',
            currency: '',
            balance: '12345.67',
            'balance-date': 1790294400,
          },
        ],
      }),
    );
    expect(vanguard.skipped).toEqual([]);
    expect(vanguard.accounts).toMatchObject([
      { source_id: 'ACT-V', institution: 'Vanguard', currency: 'USD', balance_minor: 1234567 },
    ]);
  });

  it('says a connection that wants signing in again as Plaid does, by its bank, prefix or not', () => {
    const got = toRows(
      parsed({
        errlist: [
          {
            code: 'con.auth',
            msg: 'Connection to Northwind may need attention.',
            conn_id: 'MBR-1',
          },
          { code: 'con.auth', msg: 'Connection to PSCU may need attention.', conn_id: 'MX-MBR-2' },
          { code: 'con.auth', msg: 'Connection to ? may need attention.', conn_id: 'unknown' },
        ],
        connections: [
          { conn_id: 'MX-MBR-1', name: 'Northwind' },
          { conn_id: 'MX-MBR-2', name: 'PSCU' },
        ],
        accounts: [],
      }),
    );
    expect(got.errors).toEqual([
      'Northwind needs signing in again',
      'PSCU needs signing in again',
      'con.auth: Connection to ? may need attention.',
    ]);
    expect(wantsSignIn(got.errors[0] ?? '')).toBe(true);
  });

  it('names an account kept with a transaction missing, and not one skipped whole', () => {
    expect(rows.partial).toEqual(['ACT-1']);
  });

  it('passes on the Bridge’s errors and counts holdings', () => {
    expect(rows.errors).toEqual([
      'gen.api: Requested date range exceeds limit of 90 days and was capped.',
    ]);
    expect(rows.accounts.map((a) => [a.source_id, a.holdings])).toEqual([
      ['ACT-1', 0],
      ['ACT-4', 2],
    ]);
  });
});

describe('windows', () => {
  it('lays 45-day windows back from now, newest first, edge to edge', () => {
    const day = 86_400;
    expect(windows(1000 * day, 3)).toEqual([
      { start: 955 * day, end: 1000 * day },
      { start: 910 * day, end: 955 * day },
      { start: 865 * day, end: 910 * day },
    ]);
  });
});

describe('combine', () => {
  const newer = toRows(parsed(demo));
  const row = {
    account_source_id: 'ACT-1',
    posted_at: '2026-06-01T00:00:00.000Z',
    transacted_at: null,
    amount_minor: 100,
    description: '',
    payee: null,
    memo: null,
    pending: false,
  };
  const older: Rows = {
    ...newer,
    accounts: [],
    transactions: [
      { ...row, source_id: 'T2' },
      { ...row, source_id: 'T0' },
    ],
    errors: ['gen.api: Requested date range exceeds limit of 90 days and was capped.', 'other'],
  };

  it('takes accounts from the newest window and a repeated transaction as the newest saw it', () => {
    const both = combine([newer, older]);
    expect(both.accounts).toBe(newer.accounts);
    expect(both.transactions.map((t) => `${t.source_id}:${String(t.pending)}`)).toEqual([
      'T1:false',
      'T2:true',
      'T0:false',
    ]);
    expect(both.errors).toHaveLength(2);
    expect(both.skipped).toHaveLength(8);
    expect(both.partial).toEqual(['ACT-1']);
  });

  it('is empty for no windows', () => {
    expect(combine([])).toEqual({
      accounts: [],
      transactions: [],
      skipped: [],
      errors: [],
      partial: [],
    });
  });
});

describe('report', () => {
  const lines = report(toRows(parsed(demo)));

  it('reports counts, dates and signs', () => {
    expect(lines[0]).toEqual({
      institution: 'Card Company',
      name: 'Rewards Card',
      currency: 'USD',
      balance: 'negative',
      available: 'positive',
      balanceAt: '2026-09-25',
      transactions: 2,
      pending: 1,
      credits: 1,
      debits: 1,
      earliest: '2026-06-28',
      latest: '2026-06-28',
      holdings: 0,
    });
    expect(lines[1]).toMatchObject({
      balance: 'zero',
      available: 'absent',
      transactions: 0,
      earliest: null,
      latest: null,
      holdings: 2,
    });
  });

  it('never carries an amount or a payee', () => {
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/1234|8765|550|2000|Cafe|Coffee|Refund/);
  });
});

describe('dropsFrom', () => {
  const DAY = 86_400;
  const now = 1_000 * DAY;
  const clean: Rows = { accounts: [], transactions: [], skipped: [], errors: [], partial: [] };
  const daysAgo = (n: number) => new Date((now - n * DAY) * 1000).toISOString();

  it('looks 30 days inside the 90 the nightly pull covers', () => {
    expect(NIGHTLY_WINDOWS).toBe(2);
    expect(dropsFrom(clean, windows(now, NIGHTLY_WINDOWS), now)).toBe(daysAgo(60));
  });

  it('measures from the history edge, not from a window reaching past it', () => {
    expect(dropsFrom(clean, windows(now, 8), now)).toBe(daysAgo(60));
  });

  it('measures from what a short pull covered', () => {
    expect(dropsFrom(clean, windows(now, 1), now)).toBe(daysAgo(15));
  });

  it('marks nothing when the pull covered less than the margin', () => {
    expect(dropsFrom(clean, [{ start: now - 20 * DAY, end: now }], now)).toBeNull();
    expect(dropsFrom(clean, [], now)).toBeNull();
  });

  it('marks nothing from an incomplete answer', () => {
    const covered = windows(now, 2);
    expect(dropsFrom({ ...clean, errors: ['gen.auth: re-link'] }, covered, now)).toBeNull();
    expect(dropsFrom({ ...clean, skipped: [skip] }, covered, now)).toBeNull();
  });
});

describe('historyFrom', () => {
  const DAY = 86_400;
  const now = 1_000 * DAY;
  const clean: Rows = { accounts: [], transactions: [], skipped: [], errors: [], partial: [] };
  const daysAgo = (n: number) => new Date((now - n * DAY) * 1000).toISOString();

  it('is the edge of what the pull covered, as far as the Bridge goes', () => {
    expect(historyFrom(clean, windows(now, NIGHTLY_WINDOWS), now)).toBe(daysAgo(90));
    expect(historyFrom(clean, windows(now, 8), now)).toBe(daysAgo(90));
    expect(historyFrom(clean, windows(now, 1), now)).toBe(daysAgo(45));
  });

  it('holds through an account skipped whole, which stores nothing to walk back through', () => {
    const covered = windows(now, 2);
    expect(historyFrom({ ...clean, skipped: [skip] }, covered, now)).toBe(daysAgo(90));
  });

  it('is null when a transaction or the Bridge is missing, or nothing was covered', () => {
    const covered = windows(now, 2);
    expect(historyFrom({ ...clean, partial: ['A'] }, covered, now)).toBeNull();
    expect(historyFrom({ ...clean, errors: ['gen.auth: re-link'] }, covered, now)).toBeNull();
    expect(historyFrom(clean, [], now)).toBeNull();
  });
});

const skip: Skip = { kind: 'account', account: 'A', label: 'A', why: 'x' };

describe('detail', () => {
  const clean: Rows = { accounts: [], transactions: [], skipped: [], errors: [], partial: [] };

  it('is empty for a clean pull', () => {
    expect(detail(clean)).toBe('');
  });

  it('keeps the Bridge’s words, then names each account something was left out of', () => {
    expect(detail({ ...toRows(parsed(demo)), errors: ['gen.auth: re-link'] })).toBe(
      [
        'gen.auth: re-link',
        "Card Company's Rewards Card: 1 transaction could not be read",
        "Card Company's Points was left out: its currency is not an ISO 4217 code",
        'Broken was left out: its balance is not an exact USD amount',
        "Brokerage's available balance could not be read",
      ].join('; '),
    );
  });

  it('says an account once, though every window skipped it', () => {
    const one = toRows(parsed(demo));
    const twice = combine([one, one]);
    expect(detail(twice)).toBe(detail(one));
  });

  it('counts transactions by id and keeps a name from splitting the list', () => {
    const t = (transaction: string): Skip => ({
      kind: 'transaction',
      account: 'A',
      label: accountLabel('Bank', 'Card; Gold', 'A'),
      transaction,
      why: 'x',
    });
    expect(detail({ ...clean, skipped: [t('1'), t('2'), t('1')] })).toBe(
      "Bank's Card, Gold: 2 transactions could not be read",
    );
  });
});
