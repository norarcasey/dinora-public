import { describe, expect, it } from 'vitest';

import type { AccountRow, PullRow } from './balances.ts';
import {
  accountRowSchema,
  warnedAccounts,
  compareAccounts,
  describeAge,
  formatMinor,
  isStale,
  lastRead,
  lastReads,
  pullRowSchema,
  sourceName,
  STALE_AFTER_MS,
  staleBanks,
  totalsByCurrency,
} from './balances.ts';

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'a1',
    updated_at: '2026-09-24T09:00:00+00:00',
    deleted_at: null,
    institution: 'Bank of America',
    name: 'Card',
    currency: 'USD',
    balance_minor: 0,
    balance_at: '2026-09-24T08:59:00+00:00',
    holdings: 0,
    source: 'simplefin',
    ...overrides,
  };
}

function pull(
  outcome: PullRow['outcome'],
  finishedAt: string,
  detail = '',
  source = 'simplefin',
): PullRow {
  return {
    id: `${source}-${outcome}-${finishedAt}`,
    updated_at: finishedAt,
    deleted_at: null,
    source,
    outcome,
    finished_at: finishedAt,
    detail,
  };
}

/** Intl separates with no-break spaces; the tests are about the digits, not the gaps. */
function spaced(text: string): string {
  return text.replace(/\s/g, ' ');
}

describe('the row schemas', () => {
  it('reads a row as PostgREST sends it', () => {
    const wire = {
      id: 'a1',
      updated_at: '2026-09-24T09:00:04.123456+00:00',
      deleted_at: null,
      institution: 'Bank of America',
      name: 'Card',
      currency: 'USD',
      balance_minor: -123456,
      balance_at: '2026-09-24T08:59:00+00:00',
      holdings: 1,
      source: 'simplefin',
    };
    expect(accountRowSchema.parse(wire)).toEqual(wire);
  });

  it('refuses a balance that has already lost digits to a float', () => {
    expect(accountRowSchema.safeParse(account({ balance_minor: 2 ** 53 })).success).toBe(false);
    expect(accountRowSchema.safeParse(account({ balance_minor: 1.5 })).success).toBe(false);
  });

  it('refuses a pull outcome it does not know', () => {
    expect(
      pullRowSchema.safeParse({ ...pull('ok', '2026-09-24T09:00:00Z'), outcome: 'maybe' }),
    ).toMatchObject({ success: false });
  });
});

describe('lastRead', () => {
  it('has never read when nothing has run', () => {
    expect(lastRead([])).toEqual({ kind: 'never', failed: null });
  });

  it('has never read, and says why, when every run failed', () => {
    const pulls = [
      pull('failed', '2026-09-24T09:00:30+00:00', 'first'),
      pull('failed', '2026-09-24T11:00:30+00:00', 'second'),
    ];
    expect(lastRead(pulls)).toEqual({
      kind: 'never',
      failed: { at: '2026-09-24T11:00:30+00:00', detail: 'second' },
    });
  });

  it('is the newest success, whatever order the rows arrive in', () => {
    const pulls = [
      pull('ok', '2026-09-23T09:00:05+00:00'),
      pull('ok', '2026-09-24T09:00:05+00:00'),
      pull('ok', '2026-09-22T09:00:05+00:00'),
    ];
    expect(lastRead(pulls)).toEqual({
      kind: 'read',
      at: '2026-09-24T09:00:05+00:00',
      failed: null,
      warnings: [],
    });
  });

  it('reports a failure that came after the newest success', () => {
    const pulls = [
      pull('ok', '2026-09-23T09:00:05+00:00'),
      pull('failed', '2026-09-24T09:00:50+00:00', 'timeout after 50 s'),
    ];
    expect(lastRead(pulls)).toEqual({
      kind: 'read',
      at: '2026-09-23T09:00:05+00:00',
      failed: { at: '2026-09-24T09:00:50+00:00', detail: 'timeout after 50 s' },
      warnings: [],
    });
  });

  // BANK-02's own first night: 09:00 failed, the 11:00 rerun succeeded.
  it('keeps quiet about a failure a later success has answered', () => {
    const pulls = [
      pull('failed', '2026-09-24T09:00:50+00:00', 'timeout'),
      pull('ok', '2026-09-24T11:00:05+00:00'),
    ];
    expect(lastRead(pulls)).toEqual({
      kind: 'read',
      at: '2026-09-24T11:00:05+00:00',
      failed: null,
      warnings: [],
    });
  });

  it('compares times, not the text of two different offsets', () => {
    // 10:00+02:00 is 08:00 UTC — earlier, though it sorts later as text.
    const pulls = [
      pull('ok', '2026-09-24T09:00:00+00:00'),
      pull('ok', '2026-09-24T10:00:00+02:00'),
    ];
    expect(lastRead(pulls)).toMatchObject({ at: '2026-09-24T09:00:00+00:00' });
  });

  it('ignores a deleted row', () => {
    const gone = { ...pull('ok', '2026-09-24T11:00:05+00:00'), deleted_at: '2026-09-24T12:00:00Z' };
    expect(lastRead([gone])).toEqual({ kind: 'never', failed: null });
  });

  // BANK-09: what the Bridge said on 26 Sep 2026, in a pull that stored everything else.
  it("keeps what the newest success complained of, one each, without the Bridge's codes", () => {
    const pulls = [
      pull(
        'ok',
        '2026-09-25T09:00:05+00:00',
        'con.auth: Connection to Old Bank may need attention.',
      ),
      pull(
        'ok',
        '2026-09-26T09:00:05+00:00',
        'con.auth: Connection to PSCU may need attention. Auth required; 2 row(s) could not be read',
      ),
    ];
    expect(lastRead(pulls)).toMatchObject({
      warnings: [
        'Connection to PSCU may need attention. Auth required',
        '2 row(s) could not be read',
      ],
    });
  });

  it("keeps the success's warnings beside a failure that came after it", () => {
    const pulls = [
      pull('ok', '2026-09-25T09:00:05+00:00', 'con.auth: Connection to PSCU may need attention.'),
      pull('failed', '2026-09-26T09:00:50+00:00', 'the Bridge answered HTTP 500'),
    ];
    expect(lastRead(pulls)).toMatchObject({
      failed: { detail: 'the Bridge answered HTTP 500' },
      warnings: ['Connection to PSCU may need attention.'],
    });
  });
});

describe('isStale', () => {
  const now = Date.parse('2026-09-25T09:00:00Z');

  it('is fresh for a bank refreshed at yesterday’s run', () => {
    expect(isStale('2026-09-24T09:00:00Z', now)).toBe(false);
  });

  it('is stale once a whole night has been missed', () => {
    expect(isStale(new Date(now - STALE_AFTER_MS - 1).toISOString(), now)).toBe(true);
    expect(isStale(new Date(now - STALE_AFTER_MS).toISOString(), now)).toBe(false);
  });
});

describe('describeAge', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [60_000, '1 minute ago'],
    [59 * 60_000, '59 minutes ago'],
    [3 * 3_600_000, '3 hours ago'],
    [23.9 * 3_600_000, '23 hours ago'],
    [24 * 3_600_000, 'yesterday'],
    [3 * 86_400_000, '3 days ago'],
  ])('%i ms is %s', (ms, words) => {
    expect(describeAge(ago(ms), now, 'en')).toBe(words);
  });

  it('reads a time ahead of this clock as just now', () => {
    expect(describeAge(ago(-120_000), now, 'en')).toBe('just now');
  });
});

describe('totalsByCurrency', () => {
  it('nets cards against cash in one currency', () => {
    const totals = totalsByCurrency([
      account({ id: 'a', balance_minor: 250_000 }),
      account({ id: 'b', balance_minor: -123_456 }),
    ]);
    expect(totals).toEqual([{ currency: 'USD', minor: 126_544n, accounts: 2 }]);
  });

  it('keeps currencies apart rather than adding euros to dollars', () => {
    const totals = totalsByCurrency([
      account({ id: 'a', currency: 'USD', balance_minor: 100 }),
      account({ id: 'b', currency: 'EUR', balance_minor: 200 }),
    ]);
    expect(totals).toEqual([
      { currency: 'EUR', minor: 200n, accounts: 1 },
      { currency: 'USD', minor: 100n, accounts: 1 },
    ]);
  });

  it('sums past 2^53 without losing a cent', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const totals = totalsByCurrency([
      account({ id: 'a', balance_minor: big }),
      account({ id: 'b', balance_minor: 1 }),
    ]);
    expect(totals[0]?.minor).toBe(BigInt(big) + 1n);
  });

  it('leaves out a deleted account', () => {
    expect(
      totalsByCurrency([account({ deleted_at: '2026-09-24T00:00:00Z', balance_minor: 5 })]),
    ).toEqual([]);
  });
});

describe('formatMinor', () => {
  it.each([
    [-123_456, 'USD', '-$1,234.56'],
    [5, 'USD', '$0.05'],
    [0, 'USD', '$0.00'],
    [1_500, 'JPY', '¥1,500'],
    [1_234, 'KWD', 'KWD 1.234'],
  ])('%i %s is %s', (minor, currency, text) => {
    expect(spaced(formatMinor(minor, currency, 'en-US'))).toBe(text);
  });

  it('formats a bigint total past 2^53 exactly', () => {
    expect(formatMinor(900_719_925_474_099_301n, 'USD', 'en-US')).toBe('$9,007,199,254,740,993.01');
  });

  it('follows the locale it is given', () => {
    expect(spaced(formatMinor(123_456, 'EUR', 'es-ES'))).toBe('1234,56 €');
  });
});

describe('compareAccounts', () => {
  it('orders by bank, then name', () => {
    const rows = [
      account({ id: '3', institution: 'Castellana', name: 'Cuenta' }),
      account({ id: '2', institution: 'Bank of America', name: 'Travel' }),
      account({ id: '1', institution: 'Bank of America', name: 'Cash' }),
    ];
    expect([...rows].sort(compareAccounts).map((row) => row.id)).toEqual(['1', '2', '3']);
  });
});

describe('lastReads', () => {
  it("keeps each source's failure its own, so another's success cannot hide it", () => {
    const pulls = [
      pull('ok', '2026-09-23T09:00:00Z'),
      pull('failed', '2026-09-24T09:00:00Z', 'bridge 503'),
      pull('ok', '2026-09-24T09:00:01Z', '', 'plaid'),
    ];
    expect(lastReads(pulls)).toEqual([
      {
        source: 'plaid',
        read: { kind: 'read', at: '2026-09-24T09:00:01Z', failed: null, warnings: [] },
      },
      {
        source: 'simplefin',
        read: {
          kind: 'read',
          at: '2026-09-23T09:00:00Z',
          failed: { at: '2026-09-24T09:00:00Z', detail: 'bridge 503' },
          warnings: [],
        },
      },
    ]);
  });

  it('leaves out a source whose every pull was deleted', () => {
    const gone = { ...pull('ok', '2026-09-24T09:00:00Z', '', 'plaid'), deleted_at: 'x' };
    expect(lastReads([gone, pull('ok', '2026-09-24T09:00:00Z')]).map((r) => r.source)).toEqual([
      'simplefin',
    ]);
  });
});

describe('sourceName', () => {
  it('names the aggregators, and passes anything else through', () => {
    expect(sourceName('simplefin')).toBe('SimpleFIN');
    expect(sourceName('plaid')).toBe('Plaid');
    expect(sourceName('other')).toBe('other');
  });
});

describe('warnedAccounts', () => {
  const northwind = account({ id: 'v', institution: 'Northwind', name: 'Retirement Savings' });
  const pscuCard = account({ id: 'b2', institution: 'PSCU', name: 'Visa' });
  const pscuLoan = account({ id: 'b1', institution: 'PSCU', name: 'Auto Loan' });
  const bofa = account({ id: 'bofa', institution: 'Bank of America', name: 'Cash Rewards' });
  const customers = account({ id: 'cb', institution: 'Lakeside Bank', name: 'High Yield Savings' });
  const all = [northwind, pscuCard, pscuLoan, bofa, customers];

  it("finds the accounts of the bank a warning names, in the drawer's order", () => {
    expect(warnedAccounts('Connection to PSCU may need attention. Auth required', all)).toEqual([
      pscuLoan,
      pscuCard,
    ]);
    expect(warnedAccounts('Connection to Northwind may need attention.', all)).toEqual([northwind]);
  });

  it('finds a Plaid bank by the words signInAgain writes', () => {
    expect(warnedAccounts('Lakeside Bank needs signing in again', all)).toEqual([customers]);
  });

  it('reads whole words in any case, so one bank is not found inside another', () => {
    expect(warnedAccounts('connection to bank of america may need attention', all)).toEqual([bofa]);
    const pscu = account({ id: 'x', institution: 'PSC', name: 'x' });
    expect(warnedAccounts('Connection to PSCU may need attention.', [pscu])).toEqual([]);
  });

  it('takes a name with punctuation as written, not as a pattern', () => {
    const dotted = account({ id: 'd', institution: 'U.S. Bank', name: 'x' });
    expect(warnedAccounts('Connection to U.S. Bank may need attention.', [dotted])).toEqual([
      dotted,
    ]);
    expect(warnedAccounts('Connection to USA Bank may need attention.', [dotted])).toEqual([]);
  });

  it('leaves out removed accounts, and accounts with no bank named', () => {
    const removed = account({
      id: 'r',
      institution: 'Northwind',
      deleted_at: '2026-09-25T00:00:00Z',
    });
    const nameless = account({ id: 'n', institution: ' ' });
    expect(
      warnedAccounts('Connection to Northwind may need attention.', [removed, nameless]),
    ).toEqual([]);
  });

  it('finds nothing for a warning that names no bank', () => {
    expect(warnedAccounts('gen.err: something went wrong', all)).toEqual([]);
  });
});

describe('staleBanks', () => {
  const now = Date.parse('2026-09-28T11:00:00Z');
  const fresh = '2026-09-28T09:15:00+00:00';
  const old = '2026-09-26T19:05:58+00:00';
  const older = '2026-09-26T19:05:54+00:00';
  const summitVisa = account({
    id: 'u2',
    institution: 'SUMMIT',
    name: 'Rewards Visa',
    balance_at: old,
  });
  const summitSavings = account({
    id: 'u1',
    institution: 'SUMMIT',
    name: 'Savings',
    balance_at: older,
  });
  const pscu = account({ id: 'b', institution: 'PSCU', name: 'Savings', balance_at: fresh });
  const northwind = account({
    id: 'v',
    institution: 'Northwind',
    name: 'Retirement',
    balance_at: old,
  });
  const harbor = account({
    id: 'g',
    institution: 'Harbor Mortgage',
    balance_at: old,
    source: 'plaid',
  });
  const monarch = account({ id: 'm', institution: 'Old Bank', balance_at: old, source: 'monarch' });

  it('groups the stale accounts by source and bank, dated by the newest among them', () => {
    expect(staleBanks([pscu, summitSavings, summitVisa, harbor], [], now)).toEqual([
      { source: 'plaid', institution: 'Harbor Mortgage', accounts: [harbor], since: old },
      {
        source: 'simplefin',
        institution: 'SUMMIT',
        accounts: [summitVisa, summitSavings],
        since: old,
      },
    ]);
  });

  it('leaves a bank a warning names to the warning, whose fix is under it', () => {
    expect(staleBanks([summitVisa, northwind], ['Northwind needs signing in again'], now)).toEqual([
      expect.objectContaining({ institution: 'SUMMIT' }),
    ]);
  });

  it("leaves out Monarch's accounts and removed ones: nothing reads them again", () => {
    const removed = { ...summitVisa, deleted_at: '2026-09-27T00:00:00+00:00' };
    expect(staleBanks([monarch, removed], [], now)).toEqual([]);
  });

  it('finds nothing while every balance is fresh', () => {
    expect(staleBanks([pscu], [], now)).toEqual([]);
  });
});
