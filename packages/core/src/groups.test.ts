import { describe, expect, it } from 'vitest';

import type { AccountRow } from './balances.ts';
import type { Group, GroupRow, Placement } from './groups.ts';
import {
  groupRowSchema,
  guessGroup,
  listedUnder,
  normaliseName,
  placeAccounts,
  sideOf,
} from './groups.ts';

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'a1',
    updated_at: '2026-09-24T09:00:00+00:00',
    deleted_at: null,
    institution: 'Bank',
    name: 'Savings',
    currency: 'USD',
    balance_minor: 0,
    balance_at: '2026-09-24T09:00:00+00:00',
    holdings: 0,
    source: 'simplefin',
    ...overrides,
  };
}

function chosen(accountId: string, kind: Group, deletedAt: string | null = null): GroupRow {
  return {
    id: `g-${accountId}`,
    updated_at: '2026-09-24T10:00:00+00:00',
    deleted_at: deletedAt,
    account_id: accountId,
    kind,
  };
}

describe('normaliseName', () => {
  it('keeps words and digits and drops every mark', () => {
    expect(normaliseName('Citi® Diamond Preferred® Card-7174 (7174)')).toBe(
      'citi diamond preferred card 7174 7174',
    );
    expect(normaliseName('  401(k) PLAN ')).toBe('401 k plan');
  });
});

/**
 * The names linked on 24 Sep, in their shape: the same words, punctuation and capitals, with
 * the last four digits changed.
 */
describe('guessGroup on the accounts she has linked', () => {
  const likely = (group: Group) => ({ kind: 'likely', group });

  it.each([
    'Delta SkyMiles® Reserve Card (1111)',
    'BankAmericard Visa Gold- 2222 (2222)',
    'Customized Cash Rewards Visa Signature- 3333 (3333)',
    'Travel Rewards Visa Signature- 4444 (4444)',
    'Visa Credit Card (5555)',
    'Citi® Diamond Preferred® Card-6666 (6666)',
    'PREFERRED CASH REWARDS VISA (7777)',
    'SUMMIT REWARDS AMERICAN EXPRESS (8888)',
  ])('calls %s a card, cash rewards or not', (name) => {
    expect(guessGroup(name, 0)).toEqual(likely('card'));
  });

  it.each([
    'Member Advantage Checking (1111)',
    'Member Advantage Savings (2222)',
    'Savings (3333)',
    'SUMMIT SAVINGS (4444)',
  ])('calls %s cash', (name) => {
    expect(guessGroup(name, 0)).toEqual(likely('cash'));
  });

  it('calls the auto loan a loan', () => {
    expect(guessGroup('Auto Loan (1111)', 0)).toEqual(likely('loan'));
  });

  it('hesitates over the line of credit: a loan or a card, not assumed either', () => {
    expect(guessGroup('Line of Credit (1111)', 0)).toEqual({
      kind: 'unsure',
      group: 'loan',
      or: 'card',
    });
  });

  it('calls both accounts with holdings investments, the one named after an employer too', () => {
    expect(guessGroup('GLOBEX CORP. (1111)', 1)).toEqual(likely('investment'));
    expect(guessGroup('Roth IRA *2222 (2222)', 1)).toEqual(likely('investment'));
  });
});

describe('guessGroup beyond them', () => {
  it('reads the usual names for each group', () => {
    expect(guessGroup('Adv Plus Banking - Checking', 0)).toEqual({ kind: 'likely', group: 'cash' });
    expect(guessGroup('Money Market', 0)).toEqual({ kind: 'likely', group: 'cash' });
    expect(guessGroup('12-Month CD', 0)).toEqual({ kind: 'likely', group: 'cash' });
    expect(guessGroup('Cash Management (Individual)', 0)).toEqual({
      kind: 'unsure',
      group: 'investment',
      or: 'cash',
    });
    expect(guessGroup('Cuenta Online Ejemplo', 0)).toEqual({ kind: 'likely', group: 'cash' });
    expect(guessGroup('Mortgage', 0)).toEqual({ kind: 'likely', group: 'loan' });
    expect(guessGroup('Student Loans', 0)).toEqual({ kind: 'likely', group: 'loan' });
    expect(guessGroup('Sapphire Preferred', 0)).toEqual({ kind: 'likely', group: 'card' });
    expect(guessGroup('Double Cash', 0)).toEqual({ kind: 'likely', group: 'card' });
  });

  it('reads a retirement account by name before it has any holdings', () => {
    expect(guessGroup('Meridian 401(k)', 0)).toEqual({ kind: 'likely', group: 'investment' });
    expect(guessGroup('403(b) Plan', 0)).toEqual({ kind: 'likely', group: 'investment' });
    expect(guessGroup('Brokerage', 0)).toEqual({ kind: 'likely', group: 'investment' });
    expect(guessGroup('529 College Savings', 0)).toEqual({
      kind: 'unsure',
      group: 'investment',
      or: 'cash',
    });
  });

  it('does not read the last four digits as a number that means something', () => {
    expect(guessGroup('Everyday (0529)', 0)).toEqual({ kind: 'unknown' });
    expect(guessGroup('Account 4010', 0)).toEqual({ kind: 'unknown' });
  });

  it('matches whole words only', () => {
    // `cardinal` is not `card`, `loaner` is not `loan`, `shared` is not `share`.
    expect(guessGroup('Cardinal Loaner Shared', 0)).toEqual({ kind: 'unknown' });
  });

  it('hesitates when the name says two groups, leaning to the debt', () => {
    expect(guessGroup('Savings Secured Loan', 0)).toEqual({
      kind: 'unsure',
      group: 'loan',
      or: 'cash',
    });
    expect(guessGroup('Card Loan', 0)).toEqual({ kind: 'unsure', group: 'loan', or: 'card' });
  });

  it('keeps a line of credit unsure however it is spelled or dressed', () => {
    expect(guessGroup('Personal Credit Line', 0)).toEqual({
      kind: 'unsure',
      group: 'loan',
      or: 'card',
    });
    expect(guessGroup('HELOC', 0)).toEqual({ kind: 'likely', group: 'loan' });
    expect(guessGroup('Home Equity LOC', 0)).toEqual({ kind: 'unsure', group: 'loan', or: 'card' });
    expect(guessGroup('Checking Line of Credit', 0)).toEqual({
      kind: 'unsure',
      group: 'loan',
      or: 'cash',
    });
  });

  it('hesitates over holdings in an account named as a debt', () => {
    expect(guessGroup('Rewards Visa', 2)).toEqual({
      kind: 'unsure',
      group: 'investment',
      or: 'card',
    });
  });

  it('knows nothing from a name with none of the words', () => {
    expect(guessGroup('', 0)).toEqual({ kind: 'unknown' });
    expect(guessGroup('Everyday (1234)', 0)).toEqual({ kind: 'unknown' });
  });
});

describe('placeAccounts', () => {
  it('uses her group where she set one and the guess everywhere else', () => {
    const placed = placeAccounts(
      [account({ id: 'a', name: 'Line of Credit' }), account({ id: 'b', name: 'Savings' })],
      [chosen('a', 'loan')],
    );
    expect(placed.map((p) => [p.account.id, p.placement])).toEqual([
      ['a', { kind: 'set', group: 'loan' }],
      ['b', { kind: 'likely', group: 'cash' }],
    ]);
  });

  it('lets her overrule a confident guess', () => {
    const [placed] = placeAccounts(
      [account({ id: 'a', name: 'Savings' })],
      [chosen('a', 'investment')],
    );
    expect(placed?.placement).toEqual({ kind: 'set', group: 'investment' });
  });

  it('ignores a removed choice and a removed account', () => {
    const placed = placeAccounts(
      [
        account({ id: 'a', name: 'Savings' }),
        account({ id: 'b', deleted_at: '2026-09-24T00:00:00+00:00' }),
      ],
      [chosen('a', 'loan', '2026-09-24T11:00:00+00:00')],
    );
    expect(placed.map((p) => [p.account.id, p.placement])).toEqual([
      ['a', { kind: 'likely', group: 'cash' }],
    ]);
  });
});

describe('sideOf and listedUnder', () => {
  const cases: [Placement, ReturnType<typeof sideOf>, ReturnType<typeof listedUnder>][] = [
    [{ kind: 'set', group: 'cash' }, 'cash', 'cash'],
    [{ kind: 'set', group: 'card' }, 'debt', 'card'],
    [{ kind: 'likely', group: 'loan' }, 'debt', 'loan'],
    [{ kind: 'likely', group: 'investment' }, 'investments', 'investment'],
    // A line of credit: which group is hers to say, but debt either way.
    [{ kind: 'unsure', group: 'loan', or: 'card' }, 'debt', null],
    [{ kind: 'unsure', group: 'investment', or: 'cash' }, null, null],
    [{ kind: 'unknown' }, null, null],
  ];

  it.each(cases)('%o counts toward %s and is listed under %s', (placement, side, listed) => {
    expect(sideOf(placement)).toBe(side);
    expect(listedUnder(placement)).toBe(listed);
  });
});

describe('groupRowSchema', () => {
  it('accepts the four groups and nothing else', () => {
    expect(groupRowSchema.safeParse(chosen('a', 'card')).success).toBe(true);
    expect(groupRowSchema.safeParse({ ...chosen('a', 'card'), kind: 'house' }).success).toBe(false);
  });
});
