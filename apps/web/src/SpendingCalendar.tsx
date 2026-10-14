import type { Month } from '@dinora/core/budgets';
import type { CalendarDay } from '@dinora/core/calendar';
import { calendarOf, WEEKDAYS } from '@dinora/core/calendar';
import { describeShortDay } from '@dinora/core/networth';
import { describeWeekday } from '@dinora/core/sorting';
import { useState } from 'react';

import type { BudgetMonth } from './Budget.tsx';
import { amountText, money } from './Budget.tsx';
import { Sheet } from './sheet.tsx';
import type { Filable } from './Sorting.tsx';
import { accountMeta, FilingRow, OriginKey, usePicker } from './Sorting.tsx';
import { LOCALE } from './time.tsx';

/*
 * The month as a grid of days, shaded by what each spent (BUD-03), and a day's transactions a
 * tap away. Below the categories, not above them: UI-11 made the Budget tab the list of what
 * needs looking at first, and the calendar answers a slower question, which days the money goes
 * on, that the audit (26 Sep) ranked below whether the month is on track.
 */

/** 28 Sep 2026 was a Monday; the week from it names the columns in her locale. */
const WEEK_FROM = Date.parse('2026-09-28T00:00:00Z');

function weekdayNames(style: 'short' | 'long'): string[] {
  const format = new Intl.DateTimeFormat(LOCALE, { weekday: style, timeZone: 'UTC' });
  return Array.from({ length: WEEKDAYS }, (_, i) => format.format(WEEK_FROM + i * 86_400_000));
}

function dayLabel(day: CalendarDay): string {
  const on = describeWeekday(day.day, LOCALE);
  if (day.ahead) return `${on}: still to come`;
  const count = day.entries.length;
  const transactions = count === 1 ? '1 transaction' : `${count} transactions`;
  if (count === 0) return `${on}: no transactions`;
  const spent =
    day.spent.kind === 'summed' && day.spent.minor <= 0n
      ? 'nothing spent'
      : `${amountText(day.spent)} spent`;
  const without = day.uncategorized === 0 ? '' : `, ${day.uncategorized} without a category`;
  return `${on}: ${spent}, ${transactions}${without}`;
}

export function SpendingCalendar({
  data,
  current,
  userId,
  online,
}: {
  readonly data: BudgetMonth;
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
}) {
  // The day by its date, not the day as it was: a sync while the sheet is open shows the new rows.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const picker = usePicker(data);
  const { history } = data;
  const calendar = calendarOf(data.month, data.entries, history.rates, history.today);
  const open = calendar.weeks.flat().find((d) => d !== null && d.day === openOn) ?? null;
  const short = weekdayNames('short');
  const long = weekdayNames('long');
  const anyUncategorized = calendar.weeks.flat().some((d) => d !== null && d.uncategorized > 0);

  return (
    <section className="calendar" aria-labelledby="calendar-title">
      <h3 id="calendar-title" className="budget-group-head">
        Day by day
      </h3>
      <div className="calendar-card">
        <table className="calendar-grid">
          <thead>
            <tr>
              {short.map((name, i) => (
                <th key={name} scope="col" abbr={long[i]}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendar.weeks.map((week) => (
              <tr key={week.find((d) => d !== null)?.day}>
                {week.map((day, i) =>
                  day === null ? (
                    <td key={`blank-${i}`} />
                  ) : (
                    <td key={day.day}>
                      <DayCell day={day} onOpen={() => setOpenOn(day.day)} />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="calendar-key">
          <span className="muted small">Less</span>
          {([1, 2, 3, 4] as const).map((shade) => (
            <span key={shade} className={`calendar-swatch shade-${shade}`} aria-hidden="true" />
          ))}
          <span className="muted small">More</span>
          <span className="muted small calendar-key-note">
            spent, against the month’s other days
          </span>
          {anyUncategorized && (
            <span className="muted small calendar-key-note">
              <span className="calendar-flag in-key" aria-hidden="true" /> has transactions without
              a category, not counted yet
            </span>
          )}
        </div>
        {calendar.conversions.map((c) => (
          <p key={`${c.currency}:${c.rate.id}`} className="muted small">
            {c.currency} at {c.rate.rate} to the {calendar.currency}, the ECB’s rate for{' '}
            {describeShortDay(c.rate.rate_date, LOCALE)}.
          </p>
        ))}
      </div>
      <Sheet
        title={open === null ? 'Day' : describeWeekday(open.day, LOCALE)}
        open={open !== null}
        onClose={() => setOpenOn(null)}
      >
        {open !== null && (
          <DayList
            day={open}
            data={data}
            current={current}
            userId={userId}
            online={online}
            onOpen={picker.open}
          />
        )}
      </Sheet>
      {picker.sheet}
    </section>
  );
}

/** A day with transactions opens them; a day with none, or still to come, is only a number. */
function DayCell({ day, onOpen }: { readonly day: CalendarDay; readonly onOpen: () => void }) {
  const number = Number(day.day.slice(8, 10));
  const label = dayLabel(day);
  if (day.ahead || day.entries.length === 0) {
    return (
      <span className={day.ahead ? 'calendar-day ahead' : 'calendar-day'} title={label}>
        {number}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`calendar-day shade-${day.shade}`}
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      {number}
      {day.uncategorized > 0 && <span className="calendar-flag" aria-hidden="true" />}
    </button>
  );
}

/**
 * A day's transactions, each categorized where it stands. What is uncategorized is not counted
 * in the day, as in the month, so the day's figure rises as each one is given a category.
 */
function DayList({
  day,
  data,
  current,
  userId,
  online,
  onOpen,
}: {
  readonly day: CalendarDay;
  readonly data: BudgetMonth;
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
  readonly onOpen: (entry: Filable, pick: (categoryId: string | null) => void) => void;
}) {
  const unsorted = day.uncategorized;
  return (
    <>
      <p>
        <span className="hero-value">
          {day.spent.kind === 'summed' && day.spent.minor < 0n ? money(0) : amountText(day.spent)}
        </span>{' '}
        <span className="muted small">spent</span>
      </p>
      <p className="muted small">
        {unsorted === 0
          ? 'Income and transfers are listed but not counted as spent.'
          : `${unsorted === 1 ? '1 transaction' : `${unsorted} transactions`} without a category, not counted until ${unsorted === 1 ? 'it has' : 'they have'} one. Income and transfers are listed but not counted.`}
      </p>
      <OriginKey />
      <ul className="accounts">
        {day.entries.map((entry) => (
          <FilingRow
            key={entry.transaction.id}
            entry={entry}
            meta={accountMeta(data.accounts.get(entry.transaction.account_id), entry.transaction)}
            data={data}
            current={current}
            userId={userId}
            online={online}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </>
  );
}
