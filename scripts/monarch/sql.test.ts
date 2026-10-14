import { describe, expect, it } from 'vitest';

import { decisionOf } from '../../packages/core/src/monarch.ts';
import {
  assetSql,
  decideSql,
  decisionsSql,
  findAnswer,
  linkAccountsSql,
  readAccounts,
  readAssetStored,
  readDecisions,
  readDecisionsWritten,
  readLinkAccounts,
  readRefusal,
  readStored,
  readUnready,
  readUserIds,
  storeSql,
  unreadySql,
} from './sql.ts';

const USER = '11111111-1111-1111-1111-111111111111';
const stored = {
  accounts_added: 1,
  accounts_changed: 0,
  transactions_added: 2,
  transactions_changed: 0,
  transactions_left_to_bank: 1,
  days_added: 4,
  days_changed: 0,
  days_left_to_bank: 2,
  days_matched: 1,
  days_differed: 1,
};

describe('storeSql', () => {
  it('keeps a merchant that holds the dollar-quote tag inside the literal', () => {
    const sql = storeSql(USER, {
      accounts: [],
      transactions: [
        {
          account: 'A',
          id: '1',
          on_date: '2026-01-01',
          amount_minor: 1,
          payee: "O'Brien $m0$ drop table",
          description: '',
          memo: null,
          category: null,
        },
      ],
      balances: [],
    });
    expect(sql).toContain('$m1$');
    expect(sql).toContain('set local role service_role;');
  });

  it('refuses a user id that is not a uuid', () => {
    expect(() => storeSql("x'; --", { accounts: [], transactions: [], balances: [] })).toThrow();
  });
});

describe('the mapping kept in Dinora (ACCT-18)', () => {
  const decision = decisionOf(
    "Nora's $m0$ card",
    { link: 'ACT-1', is: 'Chase · Card' },
    'from monarch-accounts.json',
    '2026-09-26T19:54:41.453Z',
  );

  it('writes decisions as her, through her own policy, never as service_role', () => {
    const sql = decideSql(USER, [decision]);
    expect(sql).toContain('set local role authenticated;');
    expect(sql).not.toContain('service_role');
    expect(sql).toContain(`"sub":"${USER}"`);
    expect(sql).toContain('$m1$');
  });

  it('reads only her live decisions', () => {
    const sql = decisionsSql(USER);
    expect(sql).toContain(`user_id = '${USER}'`);
    expect(sql).toContain('deleted_at is null');
  });

  it('refuses a user id that is not a uuid', () => {
    expect(() => decideSql("x'; --", [])).toThrow();
    expect(() => decisionsSql("x'; --")).toThrow();
  });

  it('reads the decisions and the count written back', () => {
    expect(readDecisions(JSON.stringify({ decisions: [decision] }))).toEqual({
      ok: true,
      value: [decision],
    });
    expect(readDecisions(JSON.stringify({ decisions: [{ monarch_name: 'A' }] })).ok).toBe(false);
    expect(readDecisionsWritten(JSON.stringify({ decided: 35 }))).toEqual({ ok: true, value: 35 });
  });
});

describe('assetSql', () => {
  const asset = {
    monarch_name: "Grandma's $m0$ silver",
    kind: 'valuables' as const,
    values: [{ valued_on: '2025-01-15', amount_minor: 1 }],
  };

  it('writes as her, through her own policy, never as service_role', () => {
    const sql = assetSql(USER, asset);
    expect(sql).toContain('set local role authenticated;');
    expect(sql).not.toContain('service_role');
    expect(sql).toContain(`"sub":"${USER}"`);
  });

  it('keeps a name that holds the dollar-quote tag inside the literal', () => {
    expect(assetSql(USER, asset)).toContain('$m1$');
  });

  it('refuses a user id that is not a uuid', () => {
    expect(() => assetSql("x'; --", asset)).toThrow();
  });

  it('reads what it wrote', () => {
    const answer = { asset: { added: true, removed: false, values_added: 71 } };
    expect(readAssetStored(JSON.stringify(answer))).toEqual(answer.asset);
    expect(readAssetStored('ERROR:  nope')).toBeNull();
  });
});

describe('reading an answer', () => {
  it("reads psql's bare line", () => {
    expect(readStored(`${JSON.stringify({ stored })}\n`)).toEqual(stored);
  });

  it("reads it from inside the Supabase CLI's JSON, wherever it sits", () => {
    const envelope = JSON.stringify({ rows: [{ answer: JSON.stringify({ stored }) }] });
    expect(readStored(envelope)).toEqual(stored);
    expect(readStored(JSON.stringify([{ answer: { stored } }]))).toEqual(stored);
  });

  it('reads nothing from an error or a stranger shape', () => {
    expect(readStored('ERROR:  something')).toBeNull();
    expect(readStored(JSON.stringify({ stored: { accounts_added: 'one' } }))).toBeNull();
    expect(findAnswer('{not json', 'stored')).toBeUndefined();
  });

  it('reads user ids and accounts', () => {
    expect(readUserIds(JSON.stringify({ ids: [USER] }))).toEqual({ ok: true, value: [USER] });
    expect(
      readAccounts(
        JSON.stringify({ accounts: [{ source_id: 'A', institution: 'B', name: 'C (1234)' }] }),
      ).ok,
    ).toBe(true);
  });
});

describe('linkAccountsSql', () => {
  const ID = '22222222-2222-2222-2222-222222222222';

  it('asks for the two accounts by id, and for no balance', () => {
    const sql = linkAccountsSql(USER, [ID]);
    expect(sql).toContain(`id in ('${ID}')`);
    expect(sql).not.toContain('balance');
  });

  it('refuses an id that is not a uuid, so none reaches the query unquoted', () => {
    expect(() => linkAccountsSql(USER, ["x') or true --"])).toThrow();
    expect(() => linkAccountsSql('x', [ID])).toThrow();
  });
});

describe('readLinkAccounts', () => {
  it('reads the accounts from the answer', () => {
    const row = {
      id: 'm1',
      source: 'monarch',
      source_id: 'Card (...0717)',
      institution: 'Monarch',
      name: 'Card (...0717)',
      currency: 'USD',
      deleted_at: null,
    };
    expect(readLinkAccounts(JSON.stringify({ accounts: [row] }))).toEqual({
      ok: true,
      value: [row],
    });
  });
});

describe('unreadySql', () => {
  const account = {
    monarch_name: "Joe's $m0$ card",
    link: null,
    currency: 'USD' as const,
    balance_minor: 1234,
    balance_on: '2026-09-24',
  };

  it('asks about names, links and currencies, and sends no balance', () => {
    const sql = unreadySql(USER, [account]);
    expect(sql).toContain('$m1$');
    expect(sql).not.toContain('1234');
    expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/);
  });

  it('refuses a user id that is not a uuid', () => {
    expect(() => unreadySql("x'; --", [account])).toThrow();
  });

  it('reads what it found', () => {
    const unready = [{ monarch_name: 'Robinhood', link: null, why: 'deleted' }];
    expect(readUnready(JSON.stringify({ rows: [{ answer: { unready } }] }))).toEqual({
      ok: true,
      value: unready,
    });
    expect(readUnready(JSON.stringify({ unready: [{ ...unready[0], why: 'odd' }] })).ok).toBe(
      false,
    );
  });
});

describe('readRefusal', () => {
  it("reads the Supabase CLI's error, as measured", () => {
    const printed =
      '{"_tag":"Error","error":{"code":"LegacyDbQueryExecError","message":"failed to execute query: error: monarch_store: no bank account with history for link(s) X"}}\n';
    expect(readRefusal(printed)).toBe('monarch_store: no bank account with history for link(s) X');
  });

  it("reads psql's ERROR line and never its DETAIL", () => {
    const printed =
      'psql:<stdin>:3: ERROR:  duplicate key value violates unique constraint "x"\n' +
      'DETAIL:  Key (payee)=(Grocer) already exists.\n';
    expect(readRefusal(printed)).toBe('duplicate key value violates unique constraint "x"');
  });

  it('is null when nothing says why', () => {
    expect(readRefusal('')).toBeNull();
    expect(readRefusal(JSON.stringify({ rows: [] }))).toBeNull();
  });
});
