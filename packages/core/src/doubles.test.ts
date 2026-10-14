import { describe, expect, it } from 'vitest';

import type { AccountRow } from './balances.ts';
import {
  accountDigits,
  doubledAccounts,
  goalsCounting,
  joinAnswerSchema,
  joinRefusal,
  linkCommand,
} from './doubles.ts';
import type { GoalRow } from './goals.ts';

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'a1',
    updated_at: '2026-09-26T09:00:00+00:00',
    deleted_at: null,
    institution: 'Vanguard',
    name: 'Account',
    currency: 'USD',
    balance_minor: 0,
    balance_at: '2026-09-26T09:00:00+00:00',
    holdings: 0,
    source: 'simplefin',
    ...overrides,
  };
}

const MERIDIAN_MONARCH = account({
  id: 'm1',
  source: 'monarch',
  institution: 'Monarch',
  name: 'MERIDIAN CORP 401(K) PLAN - **0717 (...0717)',
});
const MERIDIAN_BANK = account({
  id: 'b1',
  name: 'MERIDIAN CORP 401(K) PLAN - 550717',
  holdings: 3,
});

describe('accountDigits', () => {
  it('reads the number wherever the name puts it', () => {
    expect(accountDigits(MERIDIAN_MONARCH.name)).toBe('0717');
    expect(accountDigits(MERIDIAN_BANK.name)).toBe('0717');
    expect(accountDigits('Savings (0391)')).toBe('0391');
    expect(accountDigits('Gemini Credit Card (...4821)')).toBe('4821');
  });

  it('is null for a name with no run of four digits', () => {
    expect(accountDigits('Gemini Credit Card')).toBeNull();
    expect(accountDigits('401(K) Plan')).toBeNull();
    expect(accountDigits('')).toBeNull();
  });
});

describe('doubledAccounts', () => {
  it('finds the Meridian 401(k), as it was on 26 Sep', () => {
    expect(doubledAccounts([MERIDIAN_BANK, MERIDIAN_MONARCH])).toEqual([
      { monarch: MERIDIAN_MONARCH, bank: MERIDIAN_BANK },
    ]);
  });

  it('finds a Plaid account by the mask on its name', () => {
    const monarch = account({ id: 'm2', source: 'monarch', name: 'Gemini Credit Card (...4821)' });
    const plaid = account({ id: 'p2', source: 'plaid', name: 'Gemini Credit Card (4821)' });
    expect(doubledAccounts([monarch, plaid])).toEqual([{ monarch, bank: plaid }]);
  });

  it('passes over a pair already put together, whose Monarch copy is deleted', () => {
    const retired = { ...MERIDIAN_MONARCH, deleted_at: '2026-09-26T18:00:00+00:00' };
    expect(doubledAccounts([MERIDIAN_BANK, retired])).toEqual([]);
  });

  it('passes over a bank account that is deleted', () => {
    const gone = { ...MERIDIAN_BANK, deleted_at: '2026-09-26T18:00:00+00:00' };
    expect(doubledAccounts([gone, MERIDIAN_MONARCH])).toEqual([]);
  });

  it('needs the same currency', () => {
    expect(doubledAccounts([{ ...MERIDIAN_BANK, currency: 'EUR' }, MERIDIAN_MONARCH])).toEqual([]);
  });

  it('never pairs two bank accounts, or two Monarch ones', () => {
    const plaid = { ...MERIDIAN_BANK, id: 'p1', source: 'plaid' };
    const monarch = { ...MERIDIAN_MONARCH, id: 'm9', name: 'Old plan (...0717)' };
    expect(doubledAccounts([MERIDIAN_BANK, plaid])).toEqual([]);
    expect(doubledAccounts([MERIDIAN_MONARCH, monarch])).toEqual([]);
  });

  it('lists every bank account one Monarch account could be, rather than choose', () => {
    const second = account({ id: 'b2', name: 'Brokerage (0717)' });
    expect(
      doubledAccounts([MERIDIAN_MONARCH, second, MERIDIAN_BANK]).map((d) => d.bank.id),
    ).toEqual(['b2', 'b1']);
  });

  it('passes over a Monarch account with no number to match', () => {
    const monarch = account({ id: 'm3', source: 'monarch', name: 'Cash' });
    expect(doubledAccounts([monarch, account({ name: 'Cash' })])).toEqual([]);
  });
});

describe('linkCommand', () => {
  it('names both accounts by id', () => {
    expect(linkCommand({ monarch: MERIDIAN_MONARCH, bank: MERIDIAN_BANK })).toBe(
      'pnpm monarch:import --production --link m1 --to b1',
    );
  });
});

describe('goalsCounting', () => {
  const goal = (
    id: string,
    name: string,
    made: string,
    deleted: string | null = null,
  ): GoalRow => ({
    id,
    name,
    updated_at: made,
    deleted_at: deleted,
    kind: 'save',
    currency: 'USD',
    target_minor: 100_000,
    starts_on: '2026-01-01',
    target_on: null,
    created_at: made,
  });
  const link = (goalId: string, accountId: string, deleted: string | null = null) => ({
    id: `${goalId}-${accountId}`,
    updated_at: '2026-09-01T00:00:00Z',
    deleted_at: deleted,
    goal_id: goalId,
    account_id: accountId,
  });

  it('names the live goals that count the account, in the order she made them', () => {
    const goals = [
      goal('g2', 'Emergency fund', '2026-09-02T00:00:00Z'),
      goal('g1', 'Retirement', '2026-09-01T00:00:00Z'),
      goal('g3', 'Removed', '2026-09-03T00:00:00Z', '2026-09-04T00:00:00Z'),
      goal('g4', 'Other account', '2026-09-05T00:00:00Z'),
    ];
    const links = [
      link('g2', 'm1'),
      link('g1', 'm1'),
      link('g3', 'm1'),
      link('g4', 'b1'),
      link('g4', 'm1', '2026-09-06T00:00:00Z'),
    ];
    expect(goalsCounting('m1', goals, links)).toEqual(['Retirement', 'Emergency fund']);
    expect(goalsCounting('nobody', goals, links)).toEqual([]);
  });
});

describe('joinRefusal', () => {
  it('says each refusal the database raises in her words', () => {
    expect(joinRefusal('monarch_join: no_history')).toContain('wait for the next night');
    expect(joinRefusal('ERROR:  monarch_join: taken')).toContain('already put together');
  });

  it('says nothing for an error it does not know', () => {
    expect(joinRefusal('monarch_join: something_new')).toBeNull();
    expect(joinRefusal('duplicate key value violates unique constraint')).toBeNull();
  });
});

describe('joinAnswerSchema', () => {
  it('reads both answers and nothing else', () => {
    const joined = {
      kind: 'joined',
      days_moved: 1,
      days_left: 0,
      transactions_moved: 2,
      transactions_left: 0,
    };
    expect(joinAnswerSchema.safeParse(joined).success).toBe(true);
    expect(joinAnswerSchema.safeParse({ kind: 'refused', reason: 'no' }).success).toBe(true);
    expect(joinAnswerSchema.safeParse({ kind: 'joined' }).success).toBe(false);
  });
});
