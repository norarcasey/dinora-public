import { describe, expect, it } from 'vitest';

import type { TermRow } from './terms.ts';
import {
  cardTerms,
  daysBetween,
  formatRate,
  formatTenths,
  headroom,
  limitOf,
  parseLimit,
  parseRate,
  promoState,
  termRowSchema,
} from './terms.ts';

const base = {
  updated_at: '2026-09-25T10:00:00+00:00',
  deleted_at: null,
  account_id: 'card',
};

function limit(id: string, on: string, minor: number, deletedAt: string | null = null): TermRow {
  return {
    ...base,
    id,
    kind: 'credit_limit',
    effective_on: on,
    amount_minor: minor,
    rate_bp: null,
    ends_on: null,
    deleted_at: deletedAt,
  };
}

function apr(id: string, on: string, bp: number): TermRow {
  return {
    ...base,
    id,
    kind: 'purchase_apr',
    effective_on: on,
    amount_minor: null,
    rate_bp: bp,
    ends_on: null,
  };
}

describe('termRowSchema', () => {
  it('reads each kind with its own columns', () => {
    const promo = {
      ...base,
      id: 'p',
      kind: 'promo_apr',
      effective_on: '2026-01-01',
      amount_minor: null,
      rate_bp: 0,
      ends_on: '2027-04-01',
    };
    expect(termRowSchema.parse(promo)).toEqual(promo);
    expect(termRowSchema.parse(limit('l', '2026-01-01', 1_250_000)).kind).toBe('credit_limit');
  });

  it('refuses a limit carrying a rate, and a promo with no end', () => {
    expect(termRowSchema.safeParse({ ...limit('l', '2026-01-01', 1), rate_bp: 2499 }).success).toBe(
      false,
    );
    const noEnd = { ...apr('a', '2026-01-01', 0), kind: 'promo_apr' };
    expect(termRowSchema.safeParse(noEnd).success).toBe(false);
  });
});

describe('parseLimit', () => {
  it('reads what is printed on a statement', () => {
    expect(parseLimit('$12,500', 'USD')).toBe(1_250_000);
    expect(parseLimit(' 12500.00 ', 'USD')).toBe(1_250_000);
    expect(parseLimit('3000', 'EUR')).toBe(300_000);
    expect(parseLimit('0', 'USD')).toBe(0);
  });

  it('refuses a fraction of a cent, a negative, words and an unknown currency', () => {
    expect(parseLimit('12.345', 'USD')).toBeNull();
    expect(parseLimit('-500', 'USD')).toBeNull();
    expect(parseLimit('twelve', 'USD')).toBeNull();
    expect(parseLimit('', 'USD')).toBeNull();
    expect(parseLimit('500', 'usd')).toBeNull();
  });
});

describe('parseRate', () => {
  it('reads a rate with or without its percent sign', () => {
    expect(parseRate('24.99%')).toBe(2499);
    expect(parseRate('24.99')).toBe(2499);
    expect(parseRate('0')).toBe(0);
    expect(parseRate('29.990')).toBe(2999);
    expect(parseRate('100')).toBe(10_000);
  });

  it('refuses a third place, a negative, and anything past 100%', () => {
    expect(parseRate('24.999')).toBeNull();
    expect(parseRate('-1')).toBeNull();
    expect(parseRate('100.01')).toBeNull();
    expect(parseRate('APR')).toBeNull();
  });
});

describe('formatRate', () => {
  it('is as short as it is exact', () => {
    expect(formatRate(2499)).toBe('24.99%');
    expect(formatRate(2450)).toBe('24.5%');
    expect(formatRate(2405)).toBe('24.05%');
    expect(formatRate(2500)).toBe('25%');
    expect(formatRate(0)).toBe('0%');
  });
});

describe('cardTerms', () => {
  const today = '2026-09-25';

  it('takes the newest figure that has started, and holds a later one as next', () => {
    const rows = [
      limit('old', '2025-01-10', 500_000),
      limit('now', '2026-03-01', 1_000_000),
      limit('soon', '2026-11-01', 1_500_000),
      limit('later', '2027-01-01', 2_000_000),
      apr('a', '2026-09-25', 2499),
    ];
    const terms = cardTerms(rows, 'card', today);
    expect(terms.figures.credit_limit.current?.id).toBe('now');
    expect(terms.figures.credit_limit.next?.id).toBe('soon');
    // A figure dated today is in force today.
    expect(terms.figures.purchase_apr.current?.id).toBe('a');
    expect(terms.figures.cash_advance_limit).toEqual({ current: null, next: null });
    expect(terms.history.map((row) => row.id)).toEqual(['later', 'soon', 'a', 'now', 'old']);
  });

  it('leaves out removed rows and other accounts', () => {
    const rows = [
      limit('gone', '2026-09-01', 900_000, '2026-09-02T00:00:00+00:00'),
      limit('kept', '2026-08-01', 700_000),
      { ...limit('other', '2026-09-10', 1), account_id: 'another' },
    ];
    const terms = cardTerms(rows, 'card', today);
    expect(terms.figures.credit_limit.current?.id).toBe('kept');
    expect(terms.history.map((row) => row.id)).toEqual(['kept']);
  });
});

describe('limitOf', () => {
  it('reads a limit and nothing else', () => {
    expect(limitOf(limit('l', '2026-01-01', 42))).toBe(42);
    expect(limitOf(apr('a', '2026-01-01', 2499))).toBeNull();
    expect(limitOf(null)).toBeNull();
  });
});

describe('headroom', () => {
  it('is the limit less what is owed, and the share used', () => {
    expect(headroom(-234_000, 1_000_000)).toEqual({ availableMinor: 766_000, usedTenths: 234 });
  });

  it('counts a card in credit as more than its limit, with nothing used', () => {
    expect(headroom(5_000, 1_000_000)).toEqual({ availableMinor: 1_005_000, usedTenths: 0 });
  });

  it('can go below zero past the limit', () => {
    expect(headroom(-1_050_000, 1_000_000)).toEqual({
      availableMinor: -50_000,
      usedTenths: 1050,
    });
  });

  it('says nothing against a limit of zero', () => {
    expect(headroom(-100, 0)).toBeNull();
  });
});

describe('formatTenths', () => {
  it('drops a zero tenth', () => {
    expect(formatTenths(234)).toBe('23.4%');
    expect(formatTenths(230)).toBe('23%');
    expect(formatTenths(5)).toBe('0.5%');
  });
});

describe('promoState', () => {
  it('counts the days left, and warns in the last thirty', () => {
    expect(daysBetween('2026-09-25', '2026-10-25')).toBe(30);
    expect(promoState('2027-04-01', '2026-09-25')).toEqual({
      kind: 'running',
      daysLeft: 188,
      endingSoon: false,
    });
    expect(promoState('2026-10-25', '2026-09-25')).toEqual({
      kind: 'running',
      daysLeft: 30,
      endingSoon: true,
    });
  });

  it('has ended on its end date', () => {
    expect(promoState('2026-09-25', '2026-09-25')).toEqual({ kind: 'ended' });
    expect(promoState('2026-01-01', '2026-09-25')).toEqual({ kind: 'ended' });
  });
});
