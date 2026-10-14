import type { Cadence, Charge, Recurrence, Searchable } from '@dinora/core/activity';
import { findRecurring, parseQuery, search, searchText } from '@dinora/core/activity';
import type { AccountRow } from '@dinora/core/balances';
import { formatMinor } from '@dinora/core/balances';
import type {
  CategoryRow,
  ChoiceRow,
  Filer,
  Month,
  RuleRow,
  TransactionRow,
} from '@dinora/core/budgets';
import { dayOf, makeFiler, monthOf } from '@dinora/core/budgets';
import { describeDay, describeShortDay } from '@dinora/core/networth';
import type { RateRow } from '@dinora/core/rates';
import type { Pairs } from '@dinora/core/transfers';
import { pairTransfers } from '@dinora/core/transfers';
import { useDeferredValue, useMemo, useState } from 'react';

import { spendingAccounts } from './Budget.tsx';
import { useOnline } from './device/useOnline.ts';
import { ACCOUNTS, FX_RATES } from './queries/balances.ts';
import {
  CATEGORIES,
  CATEGORY_RULES,
  TRANSACTION_CATEGORIES,
  TRANSACTIONS,
} from './queries/budgets.ts';
import { ACCOUNT_GROUPS } from './queries/groups.ts';
import { useSynced } from './queries/synced.ts';
import { activityHref, payeeHref } from './route.ts';
import type { Filable } from './Sorting.tsx';
import { FilingRow, usePicker } from './Sorting.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

/** Past this many a search says how many more there are rather than drawing them all. */
export const SHOWN_AT_ONCE = 100;

export const CADENCE_NAMES: Readonly<Record<Cadence, string>> = {
  week: 'Every week',
  month: 'Every month',
  year: 'Every year',
};

/* ─── what the screens work from ────────────────────────────────────────────────────────── */

export type ActivityData = {
  /** Every transaction in an account the device holds, newest first, ready to search. */
  readonly items: readonly Searchable[];
  readonly texts: readonly string[];
  /** Charges that come back, in cash and cards, other than transfers and income. */
  readonly recurring: readonly Recurrence[];
  readonly file: Filer;
  readonly pairs: Pairs;
  readonly categories: readonly CategoryRow[];
  readonly choices: readonly ChoiceRow[];
  readonly rules: readonly RuleRow[];
  readonly transactions: readonly TransactionRow[];
  /** Every account's currency, for a payee's year across all of them. */
  readonly currencies: ReadonlyMap<string, string>;
  readonly accounts: ReadonlyMap<string, AccountRow>;
  readonly rates: readonly RateRow[];
};

/**
 * Everything Activity and a payee's page show, worked out once per change to the rows rather
 * than once per keystroke: filing and folding 8,000 transactions is the costly part, and a
 * search then only compares text.
 */
export function useActivity(today: string): ActivityData | 'waiting' | 'failed' {
  const transactions = useSynced(TRANSACTIONS);
  const categories = useSynced(CATEGORIES);
  const choices = useSynced(TRANSACTION_CATEGORIES);
  const rules = useSynced(CATEGORY_RULES);
  const accounts = useSynced(ACCOUNTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const rates = useSynced(FX_RATES);

  const txnRows = transactions.status === 'held' ? transactions.rows : null;
  const categoryRows = categories.status === 'held' ? categories.rows : EMPTY;
  const choiceRows = choices.status === 'held' ? choices.rows : EMPTY;
  const ruleRows = rules.status === 'held' ? rules.rows : EMPTY;
  const accountRows = accounts.status === 'held' ? accounts.rows : EMPTY;
  const groupRows = groups.status === 'held' ? groups.rows : EMPTY;
  const rateRows = rates.status === 'held' ? rates.rows : EMPTY;

  const worked = useMemo(() => {
    if (txnRows === null) return null;
    const currencies = new Map(accountRows.map((a) => [a.id, a.currency]));
    const pairs = pairTransfers(txnRows, currencies, today);
    const file = makeFiler(categoryRows, choiceRows, ruleRows, today, pairs);
    const live = categoryRows.filter((c) => c.deleted_at === null);
    const byId = new Map(accountRows.map((a) => [a.id, a]));
    const items: Searchable[] = [];
    for (const transaction of txnRows) {
      const account = byId.get(transaction.account_id);
      if (transaction.deleted_at !== null || account === undefined) continue;
      const filed = file(transaction);
      items.push({
        transaction,
        day: dayOf(transaction, today),
        currency: account.currency,
        accountName: account.name || 'Unnamed account',
        categoryName: filed.kind === 'none' ? null : filed.category.name,
      });
    }
    items.sort(
      (a, b) => b.day.localeCompare(a.day) || a.transaction.id.localeCompare(b.transaction.id),
    );

    const counted = new Set(spendingAccounts(accountRows, groupRows).map((a) => a.id));
    const charges: Charge[] = items.filter((i) => counted.has(i.transaction.account_id));
    const recurring = findRecurring(charges, today).filter((r) => {
      const filed = file(r.latest);
      return filed.kind === 'none' || filed.category.kind === 'spend';
    });

    return {
      items,
      texts: items.map((i) => searchText(i)),
      recurring,
      file,
      pairs,
      categories: live,
      choices: choiceRows,
      rules: ruleRows,
      transactions: txnRows,
      currencies,
      accounts: byId,
      rates: rateRows,
    };
  }, [txnRows, categoryRows, choiceRows, ruleRows, accountRows, groupRows, rateRows, today]);

  if (transactions.status === 'failed') return 'failed';
  if (worked === null || categories.status === 'waiting') return 'waiting';
  return worked;
}

// One array for every "not held", so the memo above does not see a new one on each render.
const EMPTY: readonly never[] = [];

export function money(minor: bigint | number, currency: string): string {
  return formatMinor(minor, currency, LOCALE);
}

/* ─── the page ──────────────────────────────────────────────────────────────────────────── */

/**
 * Activity (ACCT-14): one box that searches every transaction on this device, and, until
 * something is typed, the charges that come back on a schedule. Nothing here asks the server
 * anything, so it all works with no signal.
 */
export function Activity({
  query: initial,
  userId,
}: {
  readonly query: string;
  readonly userId: string;
}) {
  const now = useNow();
  const today = localDay(now);
  const data = useActivity(today);
  const [query, setQuery] = useState(initial);
  const deferred = useDeferredValue(query);

  const type = (text: string) => {
    setQuery(text);
    // Replaced, not pushed: every keystroke is not a page to go back through.
    window.history.replaceState(window.history.state, '', activityHref(text));
  };

  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed') {
    return (
      <section className="details">
        <p className="muted">
          Dinora could not be reached, and this device has no transactions saved from before.
        </p>
      </section>
    );
  }

  return (
    <section className="details activity" aria-labelledby="activity-title">
      <h2 id="activity-title">Activity</h2>
      <div className="activity-search" role="search">
        <input
          aria-label="Search transactions"
          type="search"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={`Search ${data.items.length.toLocaleString(LOCALE)} transactions`}
          value={query}
          onChange={(event) => type(event.currentTarget.value)}
        />
        <p className="muted small">
          A payee, a word from the bank, an account, a category or an amount, like 12.50.
        </p>
      </div>
      {deferred.trim() === '' ? (
        <Recurring recurring={data.recurring} today={today} />
      ) : (
        <Results query={deferred} data={data} current={monthOf(today)} userId={userId} />
      )}
    </section>
  );
}

function Results({
  query,
  data,
  current,
  userId,
}: {
  readonly query: string;
  readonly data: ActivityData;
  readonly current: Month;
  readonly userId: string;
}) {
  const online = useOnline();
  const picker = usePicker(data);
  const filing: Filing = { current, userId, online, onOpen: picker.open };
  const found = useMemo(
    () => search(parseQuery(query), data.items, data.texts, SHOWN_AT_ONCE),
    [query, data],
  );
  return (
    <section aria-labelledby="results-title" aria-live="polite">
      <h3 id="results-title">
        {found.count === 0
          ? 'Nothing found'
          : found.count === 1
            ? '1 transaction'
            : `${found.count.toLocaleString(LOCALE)} transactions`}
      </h3>
      {found.count > found.shown.length && (
        <p className="muted small">
          The newest {found.shown.length}. Add a word to narrow it down.
        </p>
      )}
      {found.shown.length > 0 && (
        <ul className="accounts">
          {found.shown.map((item) => (
            <TransactionLine key={item.transaction.id} item={item} data={data} filing={filing} />
          ))}
        </ul>
      )}
      {picker.sheet}
    </section>
  );
}

/** What a list of transactions needs to categorize one where it stands. */
export type Filing = {
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
  readonly onOpen: (entry: Filable, pick: (categoryId: string | null) => void) => void;
};

/**
 * One transaction: its payee, which opens the payee's page, when and where, the amount, and
 * where it is filed, which can be changed from here. With its year, since a search reaches back
 * years.
 */
export function TransactionLine({
  item,
  data,
  filing,
  linkPayee = true,
  nameAccount = true,
}: {
  readonly item: Pick<Searchable, 'transaction' | 'day' | 'currency' | 'accountName'>;
  readonly data: ActivityData;
  readonly filing: Filing;
  readonly linkPayee?: boolean;
  /** Off on an account's own page, where every line would name the same one. */
  readonly nameAccount?: boolean;
}) {
  const { transaction, day, currency } = item;
  return (
    <FilingRow
      entry={{ transaction, day, currency, filed: data.file(transaction) }}
      meta={[
        describeDay(day, LOCALE),
        ...(nameAccount ? [item.accountName] : []),
        ...(transaction.pending ? ['pending'] : []),
      ]}
      linkPayee={linkPayee}
      data={data}
      {...filing}
    />
  );
}

/* ─── what comes back ───────────────────────────────────────────────────────────────────── */

export function recurrenceNote(r: Recurrence, today: string): string {
  const next = describeShortDay(r.next, LOCALE);
  return r.late
    ? `${CADENCE_NAMES[r.cadence]}, expected ${next} and not seen yet`
    : r.next === today
      ? `${CADENCE_NAMES[r.cadence]}, expected today`
      : `${CADENCE_NAMES[r.cadence]}, next about ${next}`;
}

/**
 * The charges in cash and cards that come back on a schedule, the soonest expected first. Found
 * from the history, never entered: a charge is listed once it has kept a rhythm, and leaves the
 * list when it misses by more than half a period.
 */
function Recurring({
  recurring,
  today,
}: {
  readonly recurring: readonly Recurrence[];
  readonly today: string;
}) {
  return (
    <section className="activity-recurring" aria-labelledby="recurring-title">
      <h3 id="recurring-title">Recurring</h3>
      {recurring.length === 0 ? (
        <p className="muted small">
          No charge has come back on a schedule yet. One shows here after three a month apart, four
          a week apart, or two a year apart.
        </p>
      ) : (
        <>
          <p className="muted small">
            Found from the history, not entered: each has come back on a schedule at about the same
            amount.
          </p>
          <ul className="accounts">
            {recurring.map((r) => (
              <li key={`${r.key}:${r.latest.id}`}>
                <div className="account">
                  <a href={payeeHref(r.key)}>{r.name}</a>
                  <span className="muted small">{recurrenceNote(r, today)}</span>
                </div>
                <div className="amount">{money(-r.amountMinor, r.currency)}</div>
                <div className="note muted small">
                  About {money(r.perYearMinor, r.currency)} a year
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
