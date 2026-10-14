import { describe, expect, it } from 'vitest';

import { claimUrl, storeSql } from './simplefin.ts';

const USER = '11111111-1111-1111-1111-111111111111';

describe('claimUrl', () => {
  it('decodes the Bridge’s demo token', () => {
    const url = claimUrl('aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9zaW1wbGVmaW4vY2xhaW0vZGVtbw==\n');
    expect(url?.toString()).toBe('https://bridge.simplefin.org/simplefin/claim/demo');
  });

  it('refuses what does not decode to https', () => {
    expect(claimUrl(Buffer.from('http://x.test/claim').toString('base64'))).toBeNull();
    expect(claimUrl(Buffer.from('not a url').toString('base64'))).toBeNull();
    expect(claimUrl('https://x.test')).toBeNull();
  });
});

describe('storeSql', () => {
  const rows = {
    accounts: [],
    transactions: [],
    skipped: [],
    errors: [],
    partial: [],
  };
  const run = {
    startedAt: '2026-09-24T09:00:00.000Z',
    requests: 2,
    dropsFrom: null,
    historyFrom: '2026-06-26T09:00:00.000Z',
    detail: '',
  };

  it('sends the history edge inside the payload, where an older function ignores it', () => {
    expect(storeSql(USER, rows, run)).toContain('"history_from":"2026-06-26T09:00:00.000Z"');
  });

  it('calls bank_store as service_role in one transaction', () => {
    const sql = storeSql(USER, rows, run);
    expect(sql).toMatch(/^\\set ON_ERROR_STOP on\nbegin;\nset local role service_role;/);
    expect(sql).toContain('from public.bank_store(');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toMatch(/\bdelete\b/i);
  });

  it('picks a dollar-quote tag neither the payload nor the run contains', () => {
    const sql = storeSql(
      USER,
      {
        ...rows,
        transactions: [
          {
            account_source_id: 'A',
            source_id: 't',
            posted_at: null,
            transacted_at: null,
            amount_minor: 0,
            description: "O'Brien $p0$",
            payee: null,
            memo: null,
            pending: true,
          },
        ],
      },
      { ...run, detail: 'said $p1$' },
    );
    expect(sql).toContain('$p2${');
    expect(sql).not.toMatch(/\$p[01]\$\{/);
    expect(sql).toContain(`"description":"O'Brien $p0$"`);
  });

  it('refuses a user id that is not a uuid', () => {
    expect(() => storeSql("x'; drop table accounts; --", rows, run)).toThrow(/uuid/);
  });

  it('stores as the source it is given, SimpleFIN unless told', () => {
    expect(storeSql(USER, rows, run)).toContain("'simplefin',");
    expect(storeSql(USER, rows, run, 'plaid')).toContain("'plaid',");
  });
});
