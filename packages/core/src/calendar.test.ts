import { describe, expect, it } from 'vitest';

import type { CategoryRow, Entry, Filed, TransactionRow } from './budgets.ts';
import type { CalendarDay } from './calendar.ts';
import { calendarOf, weekdayOf } from './calendar.ts';
import type { RateRow } from './rates.ts';

const AT = '2026-09-25T09:00:00+00:00';

function category(id: string, kind: CategoryRow['kind'] = 'spend'): CategoryRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name: id,
    kind,
    guesses_from: [],
    created_at: AT,
  };
}

const food = category('food');
const pay = category('pay', 'income');
const move = category('move', 'transfer');

let next = 0;

function entry(
  day: string,
  minor: number,
  filedIn: CategoryRow | null = food,
  currency = 'USD',
): Entry {
  next += 1;
  const transaction: TransactionRow = {
    id: `t${next}`,
    updated_at: AT,
    deleted_at: null,
    account_id: 'card',
    posted_at: `${day}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee: 'Whole Foods',
    description: 'WHOLEFDS',
    source_category: null,
    pending: false,
  };
  const filed: Filed =
    filedIn === null ? { kind: 'none' } : { kind: 'guess', category: filedIn, from: filedIn.name };
  return { transaction, currency, day, filed };
}

function rate(rateDate: string, value: string): RateRow {
  return {
    id: rateDate,
    updated_at: AT,
    deleted_at: null,
    source: 'ecb',
    base: 'EUR',
    quote: 'USD',
    rate_date: rateDate,
    rate: value,
  };
}

function days(weeks: readonly (readonly (CalendarDay | null)[])[]): CalendarDay[] {
  return weeks.flat().filter((d) => d !== null);
}

function dayIn(weeks: readonly (readonly (CalendarDay | null)[])[], day: string): CalendarDay {
  const found = days(weeks).find((d) => d.day === day);
  if (found === undefined) throw new Error(`no ${day}`);
  return found;
}

describe('weekdayOf', () => {
  it('counts from Monday', () => {
    expect(weekdayOf('2026-09-28')).toBe(0);
    expect(weekdayOf('2026-09-26')).toBe(5);
    expect(weekdayOf('2026-09-27')).toBe(6);
  });
});

describe('calendarOf', () => {
  it('lays the month out Monday first, padded to whole weeks', () => {
    const { weeks } = calendarOf('2026-09', [], [], '2026-09-26');
    // 1 September 2026 is a Tuesday: one blank before it, four after the 30th.
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]?.[0]).toBeNull();
    expect(weeks[0]?.[1]?.day).toBe('2026-09-01');
    expect(weeks[4]?.[2]?.day).toBe('2026-09-30');
    expect(weeks[4]?.slice(3)).toEqual([null, null, null, null]);
    expect(days(weeks)).toHaveLength(30);
  });

  it('fills a month starting on a Monday with no lead', () => {
    const { weeks } = calendarOf('2027-02', [], [], '2027-03-01');
    expect(weeks).toHaveLength(4);
    expect(weeks[0]?.[0]?.day).toBe('2027-02-01');
  });

  it('marks the days after today, in the month running', () => {
    const { weeks } = calendarOf('2026-09', [], [], '2026-09-26');
    expect(dayIn(weeks, '2026-09-26').ahead).toBe(false);
    expect(dayIn(weeks, '2026-09-27').ahead).toBe(true);
  });

  it('counts spending net of refunds, and lists every entry', () => {
    const entries = [
      entry('2026-09-05', -5000),
      entry('2026-09-05', 1200),
      entry('2026-09-05', 300000, pay),
      entry('2026-09-05', -80000, move),
      entry('2026-09-05', -999, null),
    ];
    const day = dayIn(calendarOf('2026-09', entries, [], '2026-09-26').weeks, '2026-09-05');
    expect(day.spent).toEqual({ kind: 'summed', minor: 3800n });
    expect(day.entries).toHaveLength(5);
  });

  it('counts the entries with no category, which the day leaves out of spent', () => {
    const entries = [
      entry('2026-09-05', -999, null),
      entry('2026-09-05', 2500, null),
      entry('2026-09-05', -1000),
      entry('2026-09-06', -1000),
    ];
    const { weeks } = calendarOf('2026-09', entries, [], '2026-09-26');
    expect(dayIn(weeks, '2026-09-05')).toMatchObject({
      spent: { kind: 'summed', minor: 1000n },
      uncategorized: 2,
    });
    expect(dayIn(weeks, '2026-09-06').uncategorized).toBe(0);
    expect(dayIn(weeks, '2026-09-07').uncategorized).toBe(0);
  });

  it('gives a day with no spending zero and no shade', () => {
    const entries = [entry('2026-09-05', 300000, pay), entry('2026-09-06', 2000)];
    const { weeks } = calendarOf('2026-09', entries, [], '2026-09-26');
    expect(dayIn(weeks, '2026-09-05')).toMatchObject({
      spent: { kind: 'summed', minor: 0n },
      shade: 0,
    });
    expect(dayIn(weeks, '2026-09-07').shade).toBe(0);
  });

  it('gives a day whose refunds outweigh its spending no shade', () => {
    const { weeks } = calendarOf('2026-09', [entry('2026-09-05', 4000)], [], '2026-09-26');
    expect(dayIn(weeks, '2026-09-05')).toMatchObject({
      spent: { kind: 'summed', minor: -4000n },
      shade: 0,
    });
  });

  it('shades by rank in quarters, so one large day does not pale the rest', () => {
    const entries = [
      entry('2026-09-01', -1000),
      entry('2026-09-02', -2000),
      entry('2026-09-03', -3000),
      entry('2026-09-04', -250000),
    ];
    const { weeks } = calendarOf('2026-09', entries, [], '2026-09-26');
    expect(['01', '02', '03', '04'].map((d) => dayIn(weeks, `2026-09-${d}`).shade)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('gives days that spent the same the same shade, and a lone day the darkest', () => {
    const tied = calendarOf(
      '2026-09',
      [entry('2026-09-01', -1000), entry('2026-09-02', -1000), entry('2026-09-03', -9000)],
      [],
      '2026-09-26',
    ).weeks;
    expect(dayIn(tied, '2026-09-01').shade).toBe(dayIn(tied, '2026-09-02').shade);
    expect(dayIn(tied, '2026-09-03').shade).toBe(4);
    const lone = calendarOf('2026-09', [entry('2026-09-01', -1000)], [], '2026-09-26').weeks;
    expect(dayIn(lone, '2026-09-01').shade).toBe(4);
  });

  it('converts at the month summary’s rate and names it', () => {
    const rates = [rate('2026-08-29', '1.2'), rate('2026-09-10', '9')];
    const entries = [entry('2026-08-05', -1000, food, 'EUR'), entry('2026-08-05', -500)];
    const calendar = calendarOf('2026-08', entries, rates, '2026-09-26');
    expect(dayIn(calendar.weeks, '2026-08-05').spent).toEqual({ kind: 'summed', minor: 1700n });
    expect(calendar.conversions.map((c) => c.rate.id)).toEqual(['2026-08-29']);
  });

  it('leaves a day unsaid, and unshaded, when a currency has no rate', () => {
    const entries = [entry('2026-09-05', -1000, food, 'EUR'), entry('2026-09-06', -500)];
    const { weeks } = calendarOf('2026-09', entries, [], '2026-09-26');
    expect(dayIn(weeks, '2026-09-05')).toMatchObject({
      spent: { kind: 'unrated', missing: ['EUR'] },
      shade: 0,
    });
    expect(dayIn(weeks, '2026-09-06').shade).toBe(4);
  });
});
