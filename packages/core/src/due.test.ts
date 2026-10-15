import { describe, expect, it } from 'vitest';

import type { AccountRow } from './balances.ts';
import { DUE_AHEAD_DAYS, DUE_BEHIND_DAYS, dueItems } from './due.ts';
import type { GoalRow, Progress } from './goals.ts';
import type { TermRow } from './terms.ts';

const TODAY = '2026-09-26';

const AT = '2026-09-25T10:00:00+00:00';

function account(id: string, deletedAt: string | null = null): AccountRow {
  return {
    id,
    updated_at: AT,
    deleted_at: deletedAt,
    institution: 'Citi',
    name: `Card ${id}`,
    currency: 'USD',
    balance_minor: -50_000,
    balance_at: AT,
    holdings: 0,
    source: 'simplefin',
  };
}

function promo(id: string, accountId: string, from: string, ends: string, bp = 0): TermRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: accountId,
    kind: 'promo_apr',
    effective_on: from,
    amount_minor: null,
    rate_bp: bp,
    ends_on: ends,
  };
}

function apr(id: string, accountId: string, from: string, bp: number): TermRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: accountId,
    kind: 'purchase_apr',
    effective_on: from,
    amount_minor: null,
    rate_bp: bp,
    ends_on: null,
  };
}

function goal(id: string, targetOn: string | null, deletedAt: string | null = null): GoalRow {
  return {
    id,
    updated_at: AT,
    deleted_at: deletedAt,
    name: `Goal ${id}`,
    kind: 'save',
    currency: 'USD',
    target_minor: 1_000_000,
    starts_on: '2026-01-01',
    target_on: targetOn,
    created_at: AT,
  };
}

function saving(reached: boolean, onPace: boolean | null, on = '2026-10-01'): Progress {
  return {
    kind: 'save',
    balanceMinor: reached ? 1_000_000n : 500_000n,
    targetMinor: 1_000_000n,
    tenths: reached ? 1000 : 500,
    reached,
    gapMinor: reached ? 0n : 500_000n,
    pace: { kind: 'unknown' },
    deadline: { on, daysLeft: 5, perMonthNeededMinor: null, onPace },
  };
}

describe('dueItems', () => {
  it('lists a promo ending and a goal due, soonest first', () => {
    const due = dueItems(
      [account('a')],
      [promo('p', 'a', '2026-03-01', '2026-11-15', 0), apr('r', 'a', '2026-01-01', 2499)],
      [{ goal: goal('g', '2026-10-01'), progress: saving(false, false) }],
      TODAY,
    );
    expect(due.map((item) => item.kind)).toEqual(['goal', 'promo']);
    expect(due[0]).toMatchObject({ kind: 'goal', on: '2026-10-01', daysLeft: 5, onPace: false });
    expect(due[1]).toMatchObject({
      kind: 'promo',
      on: '2026-11-15',
      daysLeft: 50,
      soon: false,
      rateBp: 0,
      thenBp: 2499,
    });
  });

  it('holds only what falls between two weeks back and two months ahead', () => {
    const ends = (id: string, on: string) => promo(id, id, '2026-01-01', on);
    const due = dueItems(
      ['in', 'edge', 'far', 'past', 'gone'].map((id) => account(id)),
      [
        ends('in', '2026-10-10'),
        ends('edge', '2026-11-25'),
        ends('far', '2026-11-26'),
        ends('past', '2026-09-12'),
        ends('gone', '2026-09-11'),
      ],
      [],
      TODAY,
    );
    expect(due.map((item) => item.on)).toEqual(['2026-09-12', '2026-10-10', '2026-11-25']);
    expect(due.map((item) => item.daysLeft)).toEqual([-DUE_BEHIND_DAYS, 14, DUE_AHEAD_DAYS]);
  });

  it('warns inside the month the card’s own page warns in', () => {
    const due = dueItems(
      [account('a'), account('b')],
      [promo('p', 'a', '2026-01-01', '2026-10-26'), promo('q', 'b', '2026-01-01', '2026-10-27')],
      [],
      TODAY,
    );
    expect(due.map((item) => item.kind === 'promo' && item.soon)).toEqual([true, false]);
  });

  it('reads the rate the card goes back to on the day the promo ends, not today', () => {
    const due = dueItems(
      [account('a')],
      [
        promo('p', 'a', '2026-01-01', '2026-11-01'),
        apr('now', 'a', '2026-01-01', 1999),
        apr('rise', 'a', '2026-10-15', 2499),
      ],
      [],
      TODAY,
    );
    expect(due[0]).toMatchObject({ thenBp: 2499 });
  });

  it('says no rate when none was entered', () => {
    const due = dueItems([account('a')], [promo('p', 'a', '2026-01-01', '2026-11-01')], [], TODAY);
    expect(due[0]).toMatchObject({ thenBp: null });
  });

  it('lists a card once, by the promo in force, and not one yet to start', () => {
    const due = dueItems(
      [account('a'), account('b')],
      [
        promo('old', 'a', '2026-01-01', '2026-10-01'),
        promo('new', 'a', '2026-06-01', '2026-11-01'),
        promo('later', 'b', '2026-10-01', '2026-10-20'),
      ],
      [],
      TODAY,
    );
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ on: '2026-11-01' });
  });

  it('leaves out a removed account, a removed promo, and a removed goal', () => {
    const removed = { ...promo('p', 'b', '2026-01-01', '2026-10-01'), deleted_at: AT };
    const due = dueItems(
      [account('a', AT), account('b')],
      [promo('q', 'a', '2026-01-01', '2026-10-01'), removed],
      [{ goal: goal('g', '2026-10-01', AT), progress: saving(false, true) }],
      TODAY,
    );
    expect(due).toEqual([]);
  });

  it('leaves out a goal reached, and one with no date', () => {
    const due = dueItems(
      [],
      [],
      [
        { goal: goal('done', '2026-10-01'), progress: saving(true, true) },
        { goal: goal('open', null), progress: saving(false, null) },
      ],
      TODAY,
    );
    expect(due).toEqual([]);
  });

  it('keeps a goal whose pace cannot be told, saying so', () => {
    const due = dueItems(
      [],
      [],
      [
        { goal: goal('none', '2026-10-01'), progress: { kind: 'no-accounts' } },
        { goal: goal('rate', '2026-10-02'), progress: { kind: 'unrated' } },
        { goal: goal('slow', '2026-10-03'), progress: saving(false, null) },
      ],
      TODAY,
    );
    expect(due.map((item) => item.kind === 'goal' && item.onPace)).toEqual([null, null, null]);
  });

  it('puts the bank’s date before hers on the same day', () => {
    const due = dueItems(
      [account('a')],
      [promo('p', 'a', '2026-01-01', '2026-10-01')],
      [{ goal: goal('g', '2026-10-01'), progress: saving(false, true) }],
      TODAY,
    );
    expect(due.map((item) => item.kind)).toEqual(['promo', 'goal']);
  });
});
