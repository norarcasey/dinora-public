import type { PayeeMonth, PayeeYear } from '@dinora/core/activity';
import { payeeYear } from '@dinora/core/activity';
import type { Amount, CategoryRow, Filed } from '@dinora/core/budgets';
import { describeMonth, monthOf, rulesIn } from '@dinora/core/budgets';
import { describeShortDay } from '@dinora/core/networth';
import { NET_CURRENCY } from '@dinora/core/rates';
import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';

import type { ActivityData, Filing } from './Activity.tsx';
import { money, recurrenceNote, TransactionLine, useActivity } from './Activity.tsx';
import { Actions, Field } from './controls.tsx';
import { useOnline } from './device/useOnline.ts';
import { addRule, CATEGORY_RULES } from './queries/budgets.ts';
import { notDone } from './queries/writes.ts';
import { ACTIVITY_HREF, BUDGET_HREF } from './route.ts';
import { usePicker } from './Sorting.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

/** A payee's list starts with this many and opens the rest on asking. */
const LISTED_AT_FIRST = 50;

/**
 * One payee (ACCT-14): a year of it as twelve columns, what the year came to, where it is filed,
 * and every transaction from it. A payee is the key a rule matches (`payeeOf`), so what this
 * page calls one payee is exactly what *make it a rule* would file.
 */
export function Payee({ payee, userId }: { readonly payee: string; readonly userId: string }) {
  const now = useNow();
  const today = localDay(now);
  const data = useActivity(today);
  const year = useMemo(
    () =>
      typeof data === 'string'
        ? null
        : payeeYear(payee, data.transactions, data.currencies, data.rates, today),
    [data, payee, today],
  );

  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed' || year === null) {
    return (
      <section className="details">
        <Back />
        <p className="muted">
          {data === 'failed'
            ? 'Dinora could not be reached, and this device has no transactions saved from before.'
            : 'No transaction on this device is from this payee.'}
        </p>
      </section>
    );
  }

  const recurring = data.recurring.filter((r) => r.key === payee);
  return (
    <section className="details payee" aria-labelledby="payee-title">
      <Back />
      <h2 id="payee-title">{year.name}</h2>
      <YearSummary year={year} />
      {recurring.map((r) => (
        <p key={r.latest.id} className="small">
          {recurrenceNote(r, today)}, at {money(-r.amountMinor, r.currency)}: about{' '}
          {money(r.perYearMinor, r.currency)} a year.
        </p>
      ))}
      <Filing year={year} data={data} current={monthOf(today)} userId={userId} />
      <Transactions year={year} data={data} current={monthOf(today)} userId={userId} />
    </section>
  );
}

function Back() {
  return (
    <a className="back small" href={ACTIVITY_HREF}>
      ← Activity
    </a>
  );
}

/* ─── the year ──────────────────────────────────────────────────────────────────────────── */

/** Out when more went out than came back over the year; a paycheck's page reads the other way. */
function directionOf(year: PayeeYear): 'out' | 'in' {
  return year.net.kind === 'summed' && year.net.minor > 0n ? 'in' : 'out';
}

function yearTotal(year: PayeeYear): string {
  if (year.net.kind === 'unrated') return '—';
  return money(directionOf(year) === 'out' ? -year.net.minor : year.net.minor, NET_CURRENCY);
}

function YearSummary({ year }: { readonly year: PayeeYear }) {
  const direction = directionOf(year);
  return (
    <div className="payee-year">
      <div className="hero-value">{yearTotal(year)}</div>
      <p className="muted small">
        {direction === 'out' ? 'spent' : 'came in'} in the last twelve months,{' '}
        {year.count === 1 ? 'in 1 transaction' : `in ${year.count} transactions`}
      </p>
      {year.net.kind === 'unrated' && (
        <p className="muted small">
          Not worked out: a transaction is in a currency with no rate into {NET_CURRENCY} yet.
        </p>
      )}
      <Spark months={year.months} direction={direction} />
      {year.conversions.map((c) => (
        <p key={`${c.currency}:${c.rate.id}`} className="muted small">
          {c.currency} at {c.rate.rate} to the {NET_CURRENCY}, the ECB’s rate for{' '}
          {describeShortDay(c.rate.rate_date, LOCALE)}.
        </p>
      ))}
    </div>
  );
}

/** A month's height: what went out (or in), and nothing for a month that went the other way. */
function heightOf(net: Amount, direction: 'out' | 'in'): bigint {
  if (net.kind === 'unrated') return 0n;
  const value = direction === 'out' ? -net.minor : net.minor;
  return value > 0n ? value : 0n;
}

function shortMonth(month: string): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'short', timeZone: 'UTC' }).format(
    Date.parse(`${month}-01T00:00:00Z`),
  );
}

const SLOT = 20;
const BAR = 12;
const HEIGHT = 48;
const RADIUS = 3;

/** A column with a rounded data end and a square foot on the baseline. */
function columnPath(x: number, top: number): string {
  const r = Math.min(RADIUS, (HEIGHT - top) / 2, BAR / 2);
  return [
    `M${x},${HEIGHT}`,
    `V${top + r}`,
    `Q${x},${top} ${x + r},${top}`,
    `H${x + BAR - r}`,
    `Q${x + BAR},${top} ${x + BAR},${top + r}`,
    `V${HEIGHT}`,
    'Z',
  ].join(' ');
}

/**
 * Twelve columns, one hue, the running month lighter because it is not over. Columns rather
 * than a line: each is one month's total, a magnitude, and a line between two months would
 * draw spending on days that had none. Each column names its month and amount on hover and to
 * a screen reader, and the same twelve figures are a table beside it.
 */
function Spark({
  months,
  direction,
}: {
  readonly months: readonly PayeeMonth[];
  readonly direction: 'out' | 'in';
}) {
  const heights = months.map((m) => heightOf(m.net, direction));
  const tallest = heights.reduce((a, h) => (h > a ? h : a), 0n);
  const label = (m: PayeeMonth) =>
    `${describeMonth(m.month, LOCALE)}: ${
      m.net.kind === 'unrated' ? 'not worked out' : money(heightOf(m.net, direction), NET_CURRENCY)
    }`;
  const last = months.length - 1;
  return (
    <figure className="spark">
      <svg
        viewBox={`0 0 ${months.length * SLOT} ${HEIGHT + 14}`}
        role="img"
        aria-label={`${direction === 'out' ? 'Spent' : 'Came in'} each month, the last twelve`}
      >
        <line className="spark-base" x1={0} x2={months.length * SLOT} y1={HEIGHT} y2={HEIGHT} />
        {months.map((m, i) => {
          const h = heights[i] ?? 0n;
          const x = i * SLOT + (SLOT - BAR) / 2;
          // Scaled in bigint and only then made a number: a few pixels, never an amount.
          const px = tallest === 0n ? 0 : Number((h * BigInt(HEIGHT - 2)) / tallest);
          return (
            <g key={m.month}>
              <title>{label(m)}</title>
              {/* The whole slot answers the pointer, not just a column a few pixels tall. */}
              <rect className="spark-hit" x={i * SLOT} y={0} width={SLOT} height={HEIGHT} />
              {px > 0 && (
                <path
                  className={i === last ? 'spark-bar running' : 'spark-bar'}
                  d={columnPath(x, HEIGHT - px)}
                />
              )}
            </g>
          );
        })}
        {[0, last].map((i) => {
          const m = months[i];
          return m === undefined ? null : (
            <text
              key={m.month}
              className="spark-tick"
              x={i * SLOT + SLOT / 2}
              y={HEIGHT + 12}
              textAnchor="middle"
            >
              {shortMonth(m.month)}
            </text>
          );
        })}
      </svg>
      <details className="spark-table small">
        <summary>As a table</summary>
        <table>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <th scope="row">{describeMonth(m.month, LOCALE)}</th>
                <td>
                  {m.net.kind === 'unrated'
                    ? 'Not worked out'
                    : money(direction === 'out' ? -m.net.minor : m.net.minor, NET_CURRENCY)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/* ─── where it is filed ─────────────────────────────────────────────────────────────────── */

function filedSentence(filed: Filed): string {
  switch (filed.kind) {
    case 'none':
      return 'The newest has no category.';
    case 'chosen':
      return `The newest is filed under ${filed.category.name}, by your choice.`;
    case 'rule':
      return `Filed under ${filed.category.name} by a rule.`;
    case 'paired':
      return `The newest is under ${filed.category.name}, paired with its other side as a transfer.`;
    case 'guess':
      return `The newest is under ${filed.category.name}, from Monarch’s ${filed.from}.`;
  }
}

/**
 * Where the payee's transactions go, and a rule to send them all one place. As on the budget
 * (BUD-01), a rule is made from the first of this month: this month's sort can change, no
 * earlier month's does, and the page says so before it saves.
 */
function Filing({
  year,
  data,
  current,
  userId,
}: {
  readonly year: PayeeYear;
  readonly data: ActivityData;
  readonly current: string;
  readonly userId: string;
}) {
  const client = useQueryClient();
  const online = useOnline();
  const rule = rulesIn(current, data.rules).find((r) => r.payee === year.key) ?? null;
  const ruled = data.categories.find((c) => c.id === rule?.category_id) ?? null;
  const [chosen, setChosen] = useState(ruled?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const newest = year.all[0];
  if (newest === undefined) return null;

  const save = async (categoryId: string | null) => {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await addRule(userId, year.key, categoryId, current);
      await client.invalidateQueries({ queryKey: CATEGORY_RULES.queryKey });
      setSaved(true);
      if (categoryId === null) setChosen('');
    } catch (error) {
      setProblem(notDone(error, 'saved'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (chosen === '') {
      setProblem('Pick the category every one of them goes under.');
      return;
    }
    void save(chosen);
  };

  const monthName = describeMonth(current, LOCALE);
  const off = !online || busy;
  return (
    <section className="payee-filing" aria-labelledby="filing-title">
      <h3 id="filing-title">Filed under</h3>
      <p className="small">{filedSentence(data.file(newest.transaction))}</p>
      {rule !== null && (
        <p className="muted small">
          A rule files every “{year.key}” under {ruled?.name ?? 'a removed category'} from{' '}
          {describeMonth(monthOf(rule.starts_on), LOCALE)} on.{' '}
          <button
            type="button"
            className="quiet"
            disabled={off}
            onClick={() => void save(null)}
            aria-label={`Stop the rule for ${year.key}`}
          >
            Stop it
          </button>
        </p>
      )}
      {data.categories.length === 0 ? (
        <p className="muted small">
          A rule needs a category to file into. Make one on the <a href={BUDGET_HREF}>budget</a>.
        </p>
      ) : (
        <form className="add-figure" onSubmit={submit}>
          <div className="fields">
            <Field
              label={rule === null ? 'Make it a rule' : 'Change the rule'}
              hint={`Every “${year.key}” from ${monthName} on. Earlier months stay as they were.`}
              error={problem}
            >
              {(control) => (
                <select
                  {...control}
                  value={chosen}
                  disabled={off}
                  onChange={(event) => {
                    setChosen(event.currentTarget.value);
                    setProblem(null);
                    setSaved(false);
                  }}
                >
                  <option value="">Pick a category</option>
                  {[...data.categories]
                    .sort((a: CategoryRow, b: CategoryRow) => a.name.localeCompare(b.name))
                    .map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          </div>
          <Actions saved={saved}>
            <button type="submit" disabled={off || (ruled !== null && chosen === ruled.id)}>
              {busy ? 'Saving…' : rule === null ? 'Make it a rule' : 'Change the rule'}
            </button>
          </Actions>
        </form>
      )}
    </section>
  );
}

/* ─── every transaction ─────────────────────────────────────────────────────────────────── */

function Transactions({
  year,
  data,
  current,
  userId,
}: {
  readonly year: PayeeYear;
  readonly data: ActivityData;
  readonly current: string;
  readonly userId: string;
}) {
  const online = useOnline();
  const picker = usePicker(data);
  const filing: Filing = { current, userId, online, onOpen: picker.open };
  const [all, setAll] = useState(false);
  const shown = all ? year.all : year.all.slice(0, LISTED_AT_FIRST);
  return (
    <section aria-labelledby="payee-transactions-title">
      <h3 id="payee-transactions-title">
        Transactions{' '}
        <span className="muted small">
          {year.all.length === 1 ? '1 in all' : `${year.all.length} in all`}
        </span>
      </h3>
      <ul className="accounts">
        {shown.map(({ transaction, day }) => (
          <TransactionLine
            key={transaction.id}
            item={{
              transaction,
              day,
              currency: data.currencies.get(transaction.account_id) ?? NET_CURRENCY,
              accountName: data.accounts.get(transaction.account_id)?.name || 'Unnamed account',
            }}
            data={data}
            filing={filing}
            linkPayee={false}
          />
        ))}
      </ul>
      {shown.length < year.all.length && (
        <button type="button" className="quiet small" onClick={() => setAll(true)}>
          Show all {year.all.length}
        </button>
      )}
      {picker.sheet}
    </section>
  );
}
