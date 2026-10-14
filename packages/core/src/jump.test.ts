import { describe, expect, it } from 'vitest';

import type { TransactionRow } from './budgets.ts';
import type { JumpSources } from './jump.ts';
import { findJumps, jumpTargets } from './jump.ts';

const AT = '2026-09-25T09:00:00+00:00';
const TODAY = '2026-09-25';

function txn(id: string, on: string, payee: string | null, description = ''): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: 'card',
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: -1000,
    payee,
    description,
    source_category: null,
    pending: false,
  };
}

function sources(overrides: Partial<JumpSources> = {}): JumpSources {
  return {
    accounts: [
      { id: 'visa', name: 'Visa Signature', institution: 'Chase', deleted_at: null },
      { id: 'gone', name: 'Old Checking', institution: 'Chase', deleted_at: AT },
      { id: 'blank', name: '', institution: '', deleted_at: null },
    ],
    goals: [
      { id: 'g1', name: 'Emergency fund', deleted_at: null },
      { id: 'g2', name: 'Retired goal', deleted_at: AT },
    ],
    assets: [
      { id: 'car', name: 'Civic', deleted_at: null },
      { id: 'sold', name: 'Bike', deleted_at: AT },
    ],
    transactions: [
      txn('t1', '2026-07-03', 'Netflix'),
      txn('t2', '2026-08-03', 'NETFLIX'),
      txn('t3', '2026-09-03', 'Netflix'),
      txn('t4', '2026-09-10', 'Café Núñez'),
      txn('t5', '2026-09-11', null, 'ADVISOR FEE'),
      { ...txn('t6', '2024-01-01', 'Deleted Payee'), deleted_at: AT },
    ],
    today: TODAY,
    locale: 'en-US',
    ...overrides,
  };
}

describe('jumpTargets', () => {
  it('lists what is not deleted, accounts then goals then things owned then payees then months', () => {
    const targets = jumpTargets(sources());
    const kinds = targets.map((t) => t.kind);
    expect(kinds.indexOf('goal')).toBeGreaterThan(kinds.lastIndexOf('account'));
    expect(kinds.indexOf('asset')).toBeGreaterThan(kinds.lastIndexOf('goal'));
    expect(kinds.indexOf('payee')).toBeGreaterThan(kinds.lastIndexOf('asset'));
    expect(kinds.indexOf('month')).toBeGreaterThan(kinds.lastIndexOf('payee'));
    const labels = targets.map((t) => t.label);
    expect(labels).not.toContain('Old Checking');
    expect(labels).not.toContain('Retired goal');
    expect(labels).not.toContain('Bike');
    expect(labels).not.toContain('Deleted Payee');
  });

  it('names an unnamed account, and says the bank under each account', () => {
    const accounts = jumpTargets(sources()).filter((t) => t.kind === 'account');
    expect(accounts).toEqual([
      expect.objectContaining({ id: 'visa', label: 'Visa Signature', detail: 'Chase' }),
      expect.objectContaining({ id: 'blank', label: 'Unnamed account', detail: 'Account' }),
    ]);
  });

  it('makes one payee of every spelling a rule would, named as the newest, most paid first', () => {
    const payees = jumpTargets(sources()).filter((t) => t.kind === 'payee');
    expect(payees.map((p) => [p.label, p.detail])).toEqual([
      ['Netflix', 'Payee, 3 times'],
      ['ADVISOR FEE', 'Payee, once'],
      ['Café Núñez', 'Payee, once'],
    ]);
  });

  it('names a payee by the spelling the bank used last', () => {
    const payees = jumpTargets(
      sources({
        transactions: [txn('a', '2026-09-01', 'NETFLIX'), txn('b', '2026-08-01', 'Netflix')],
      }),
    ).filter((t) => t.kind === 'payee');
    expect(payees.map((p) => p.label)).toEqual(['NETFLIX']);
  });

  it('leaves out a transaction with no payee and no description', () => {
    const payees = jumpTargets(
      sources({ transactions: [txn('a', '2026-09-01', null, '  ')] }),
    ).filter((t) => t.kind === 'payee');
    expect(payees).toEqual([]);
  });

  it('offers every month from the first transaction to this one, newest first', () => {
    const months = jumpTargets(sources()).filter((t) => t.kind === 'month');
    expect(months.map((m) => [m.id, m.label])).toEqual([
      ['2026-09', 'September 2026'],
      ['2026-08', 'August 2026'],
      ['2026-07', 'July 2026'],
    ]);
  });

  it('offers this month alone with no transactions', () => {
    const months = jumpTargets(sources({ transactions: [] })).filter((t) => t.kind === 'month');
    expect(months.map((m) => m.id)).toEqual(['2026-09']);
  });
});

describe('findJumps', () => {
  const targets = jumpTargets(sources());
  const find = (query: string, limit = 20) => findJumps(query, targets, limit).map((t) => t.label);

  it('finds nothing until something is typed', () => {
    expect(find('')).toEqual([]);
    expect(find('   ')).toEqual([]);
  });

  it('puts a label that begins with what was typed before one that only contains it', () => {
    expect(find('vis')).toEqual(['Visa Signature', 'ADVISOR FEE']);
  });

  it('ranks every word starting a word above a word found mid-word', () => {
    expect(find('fee')).toEqual(['ADVISOR FEE']);
    expect(find('sig')).toEqual(['Visa Signature']);
    expect(find('und')).toEqual(['Emergency fund']);
    expect(find('fund e')).toEqual(['Emergency fund']);
  });

  it('needs every word, folded for case and accents', () => {
    expect(find('cafe nunez')).toEqual(['Café Núñez']);
    expect(find('cafe visa')).toEqual([]);
  });

  it('finds an account by its bank', () => {
    expect(find('chase')).toEqual(['Visa Signature']);
  });

  it('finds a month by its name or its number', () => {
    expect(find('aug')).toEqual(['August 2026']);
    expect(find('2026-07')).toEqual(['July 2026']);
    expect(find('july 26')).toEqual(['July 2026']);
  });

  it('keeps the order given within a rank, and stops at the limit', () => {
    expect(find('2026')).toEqual(['September 2026', 'August 2026', 'July 2026']);
    expect(find('2026', 2)).toEqual(['September 2026', 'August 2026']);
  });

  it('carries what its page is opened by', () => {
    expect(findJumps('netflix', targets, 5)).toEqual([
      expect.objectContaining({ kind: 'payee', id: 'netflix' }),
    ]);
    expect(findJumps('civ', targets, 5)).toEqual([
      expect.objectContaining({ kind: 'asset', id: 'car', detail: 'Something you own' }),
    ]);
    expect(findJumps('emergency', targets, 5)).toEqual([
      expect.objectContaining({ kind: 'goal', id: 'g1', detail: 'Goal' }),
    ]);
  });
});
