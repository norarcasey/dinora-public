import { toMinor } from './money.ts';
import { parseCsv } from './monarch.ts';

/**
 * A lender's statement (ACCT-20): a loan's unpaid principal after each entry, copied from the
 * lender's own history into a CSV of `Date,Principal,Unpaid principal balance`, one row per
 * entry in any order, dates as the lender writes them (MM/DD/YYYY) or ISO.
 *
 * The file is typed or copied by hand from a PDF, so it is checked against itself before a
 * figure is stored: each day's balance must be the day before's less that day's principal.
 * Harbor's history holds both, and they agree to the cent over 2023–2026 (measured 26 Sep
 * 2026), so a wrong digit anywhere breaks the chain and the file is refused. Checked by day,
 * not by row: on a day with two entries (a payment and a county tax on 2 Oct 2023) Harbor
 * prints the day's closing balance on both, whatever order it lists them in. A refusal names
 * the line, never an amount (invariant 4).
 *
 * The balance is what is owed, so it is stored negative, in the cardholder's sign every other
 * account uses (BANK-01).
 */

export type StatementDay = { readonly on_date: string; readonly balance_minor: number };

export type Statement =
  | {
      readonly ok: true;
      readonly entries: number;
      readonly days: readonly StatementDay[];
    }
  | { readonly ok: false; readonly reason: string };

const HEADER = ['date', 'principal', 'unpaid principal balance'];

function isoDate(text: string): string | null {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = us === null ? text : `${us[3]}-${us[1]}-${us[2]}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** `$120,533.19` and `(111.44)` as the lender prints them, in cents. */
function cents(text: string): number | null {
  const bare = text.replace(/[$,\s]/g, '');
  const negative = /^\(.*\)$/.test(bare);
  const minor = toMinor(negative ? `-${bare.slice(1, -1)}` : bare, 2);
  return minor.ok ? minor.minor : null;
}

export function readStatement(text: string): Statement {
  const table = parseCsv(text);
  if (table === null) return { ok: false, reason: 'a quote is left open' };
  const [header, ...lines] = table;
  const names = (header ?? []).map((name) => name.trim().toLowerCase());
  if (HEADER.some((name, i) => names[i] !== name)) {
    return { ok: false, reason: 'the header is not Date,Principal,Unpaid principal balance' };
  }
  const rows: { line: number; on_date: string; principal: number; balance: number }[] = [];
  for (const [i, cells] of lines.entries()) {
    if (cells.every((cell) => cell.trim() === '')) continue;
    const line = i + 2;
    const onDate = isoDate((cells[0] ?? '').trim());
    const principal = cents(cells[1] ?? '');
    const balance = cents(cells[2] ?? '');
    if (onDate === null) return { ok: false, reason: `line ${line}: the date cannot be read` };
    if (principal === null || balance === null) {
      return { ok: false, reason: `line ${line}: an amount cannot be read` };
    }
    rows.push({ line, on_date: onDate, principal, balance });
  }
  if (rows.length === 0) return { ok: false, reason: 'there are no entries' };

  const byDay = new Map<string, { balance: number; principal: number }>();
  for (const row of rows.toSorted((a, b) => a.on_date.localeCompare(b.on_date))) {
    const day = byDay.get(row.on_date);
    if (day !== undefined && day.balance !== row.balance) {
      return { ok: false, reason: `line ${row.line}: the day's entries disagree on the balance` };
    }
    byDay.set(row.on_date, {
      balance: row.balance,
      principal: (day?.principal ?? 0) + row.principal,
    });
  }
  const days = [...byDay];
  for (const [i, [onDate, day]] of days.entries()) {
    const before = days[i - 1]?.[1];
    if (before !== undefined && before.balance - day.principal !== day.balance) {
      const line = rows.find((row) => row.on_date === onDate)?.line ?? 0;
      return {
        ok: false,
        reason: `line ${line}: the balance is not the day before's less the principal`,
      };
    }
  }
  return {
    ok: true,
    entries: rows.length,
    days: days.map(([on_date, day]) => ({
      on_date,
      balance_minor: day.balance === 0 ? 0 : -day.balance,
    })),
  };
}
