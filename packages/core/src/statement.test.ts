import { describe, expect, it } from 'vitest';

import { readStatement } from './statement.ts';

const HEADER = 'Date,Principal,Unpaid principal balance';

describe('a lender’s statement (ACCT-20)', () => {
  it('reads the unpaid principal as owed, oldest first, one figure a day', () => {
    const read = readStatement(
      [
        HEADER,
        '01/13/2025,$0.00,"$120,533.19"',
        '01/02/2025,$547.56,"$120,533.19"',
        '12/11/2024,$0.00,"$121,080.75"',
        '12/02/2024,$544.44,"$121,080.75"',
        '11/14/2024,$0.00,"$121,625.19"',
        '',
      ].join('\n'),
    );
    expect(read).toEqual({
      ok: true,
      entries: 5,
      days: [
        { on_date: '2024-11-14', balance_minor: -12_162_519 },
        { on_date: '2024-12-02', balance_minor: -12_108_075 },
        { on_date: '2024-12-11', balance_minor: -12_108_075 },
        { on_date: '2025-01-02', balance_minor: -12_053_319 },
        { on_date: '2025-01-13', balance_minor: -12_053_319 },
      ],
    });
  });

  it('takes a day’s entries together, since each prints the day’s closing balance', () => {
    const read = readStatement(
      [
        HEADER,
        '10/02/2023,502.60,128427.04',
        '10/02/2023,0.00,128427.04',
        '09/13/2023,0.00,128929.64',
      ].join('\n'),
    );
    expect(read.ok && read.days).toEqual([
      { on_date: '2023-09-13', balance_minor: -12_892_964 },
      { on_date: '2023-10-02', balance_minor: -12_842_704 },
    ]);
    expect(
      readStatement([HEADER, '2023-10-02,502.60,128427.04', '2023-10-02,0,128929.64'].join('\n')),
    ).toEqual({ ok: false, reason: "line 3: the day's entries disagree on the balance" });
  });

  it('refuses a figure that breaks the chain, naming the line and no amount', () => {
    const read = readStatement(
      [HEADER, '01/02/2025,547.56,120533.18', '12/02/2024,544.44,121080.75'].join('\n'),
    );
    expect(read).toEqual({
      ok: false,
      reason: "line 2: the balance is not the day before's less the principal",
    });
  });

  it('reads a principal in brackets as taken back, and a paid-off loan as nothing owed', () => {
    const read = readStatement(
      [HEADER, '2026-01-01,0,100.00', '2026-02-01,(10.00),110.00', '2026-03-01,110,0'].join('\n'),
    );
    expect(read.ok && read.days.map((day) => day.balance_minor)).toEqual([-10_000, -11_000, 0]);
  });

  it('refuses a file it cannot read', () => {
    expect(readStatement('Date,Amount\n')).toEqual({
      ok: false,
      reason: 'the header is not Date,Principal,Unpaid principal balance',
    });
    expect(readStatement(`${HEADER}\n`)).toEqual({ ok: false, reason: 'there are no entries' });
    expect(readStatement(`${HEADER}\n02/30/2025,0,1`)).toEqual({
      ok: false,
      reason: 'line 2: the date cannot be read',
    });
    expect(readStatement(`${HEADER}\n2025-02-01,abc,1`)).toEqual({
      ok: false,
      reason: 'line 2: an amount cannot be read',
    });
    expect(readStatement(`${HEADER}\n"2025-02-01,0,1`)).toEqual({
      ok: false,
      reason: 'a quote is left open',
    });
  });
});
