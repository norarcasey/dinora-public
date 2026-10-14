import type { AccountRow } from '@dinora/core/balances';
import { formatMinor } from '@dinora/core/balances';
import type {
  Amount,
  BudgetRow,
  CategoryRow,
  ChoiceRow,
  Entry,
  Filer,
  Month,
  MonthSummary,
  RuleRow,
  SpendLine,
  TransactionRow,
  Unclaimed,
} from '@dinora/core/budgets';
import {
  describeMonth,
  entriesIn,
  makeFiler,
  monthOf,
  shiftMonth,
  startingCategories,
  summarise,
  unclaimedSources,
} from '@dinora/core/budgets';
import { listedUnder, placeAccounts } from '@dinora/core/groups';
import { describeShortDay } from '@dinora/core/networth';
import type { History, MonthClock, Placed, Standing } from '@dinora/core/pace';
import { byAttention, monthClock, standingOf } from '@dinora/core/pace';
import { NET_CURRENCY } from '@dinora/core/rates';
import type { Pairs } from '@dinora/core/transfers';
import { pairTransfers } from '@dinora/core/transfers';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AddCategory, BudgetForm } from './CategoryForms.tsx';
import { useOnline } from './device/useOnline.ts';
import { GoalsInBudget } from './GoalsInBudget.tsx';
import { ACCOUNTS, FX_RATES } from './queries/balances.ts';
import {
  addCategories,
  CATEGORIES,
  CATEGORY_BUDGETS,
  CATEGORY_RULES,
  TRANSACTION_CATEGORIES,
  TRANSACTIONS,
} from './queries/budgets.ts';
import { ACCOUNT_GROUPS } from './queries/groups.ts';
import { useSynced } from './queries/synced.ts';
import { notDone } from './queries/writes.ts';
import { budgetHref, CATEGORIES_HREF, categorizeHref, categoryHref } from './route.ts';
import { Sheet } from './sheet.tsx';
import { SpendingCalendar } from './SpendingCalendar.tsx';
import { SpendingPace } from './SpendingPace.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

/*
 * A month against its budgets (BUD-01), redone as the month alone (UI-11). Nora, 26 Sep: "The
 * budget is too hard to use, the page is really long, and it feels like everything is one big
 * list." It held the month, every category as a bar, the last week's transactions, every rule,
 * and every category again with its form. Now it holds the month: categories in the order they
 * need looking at, with each budget set from the list. A category's transactions are on its own
 * page (`Category.tsx`), and categories and rules are behind one link (`Categories.tsx`).
 */

/* ─── the month, worked out ─────────────────────────────────────────────────────────────── */

export type BudgetMonth = {
  readonly month: Month;
  readonly summary: MonthSummary;
  readonly entries: readonly Entry[];
  readonly categories: readonly CategoryRow[];
  readonly budgets: readonly BudgetRow[];
  readonly choices: readonly ChoiceRow[];
  readonly rules: readonly RuleRow[];
  readonly transactions: readonly TransactionRow[];
  readonly accounts: ReadonlyMap<string, AccountRow>;
  /** Where any transaction is filed, as today's rows say. */
  readonly file: Filer;
  /** Both sides of each transfer between her accounts, any group (BUD-05). */
  readonly pairs: Pairs;
  /** What another month's spending is worked out from: the budget sheet's months before. */
  readonly history: History;
};

/**
 * The accounts a budget counts: cash and cards, where spending happens. Not loans, whose
 * payments are the other side of a transfer already counted, and not investment accounts,
 * whose buys and sells are not spending. By the group she set or the one guessed (ACCT-04).
 */
export function spendingAccounts(
  accounts: readonly AccountRow[],
  groups: Parameters<typeof placeAccounts>[1],
): AccountRow[] {
  return placeAccounts(accounts, groups)
    .filter((p) => {
      const group = listedUnder(p.placement);
      return group === 'cash' || group === 'card';
    })
    .map((p) => p.account);
}

/**
 * Everything a month's page shows; `waiting` while the transactions or categories have not been
 * read from the disk or the server yet, and `failed` when a read failed with nothing held.
 */
export function useBudgetMonth(month: Month, today: string): BudgetMonth | 'waiting' | 'failed' {
  const transactions = useSynced(TRANSACTIONS);
  const categories = useSynced(CATEGORIES);
  const budgets = useSynced(CATEGORY_BUDGETS);
  const choices = useSynced(TRANSACTION_CATEGORIES);
  const rules = useSynced(CATEGORY_RULES);
  const accounts = useSynced(ACCOUNTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const rates = useSynced(FX_RATES);

  if (transactions.status === 'failed' || categories.status === 'failed') return 'failed';
  if (transactions.status === 'waiting' || categories.status === 'waiting') return 'waiting';

  const heldBudgets = budgets.status === 'held' ? budgets.rows : [];
  const heldChoices = choices.status === 'held' ? choices.rows : [];
  const heldRules = rules.status === 'held' ? rules.rows : [];
  const heldRates = rates.status === 'held' ? rates.rows : [];
  const heldAccounts = accounts.status === 'held' ? accounts.rows : [];
  const counted = spendingAccounts(heldAccounts, groups.status === 'held' ? groups.rows : []);
  const currencies = new Map(counted.map((account) => [account.id, account.currency]));
  const pairs = pairTransfers(
    transactions.rows,
    new Map(heldAccounts.map((account) => [account.id, account.currency])),
    today,
  );
  const file = makeFiler(categories.rows, heldChoices, heldRules, today, pairs);
  const entries = entriesIn(month, transactions.rows, currencies, file, today);
  return {
    month,
    summary: summarise(month, entries, categories.rows, heldBudgets, heldRates, today),
    entries,
    categories: categories.rows.filter((c) => c.deleted_at === null),
    budgets: heldBudgets,
    choices: heldChoices,
    rules: heldRules,
    transactions: transactions.rows,
    accounts: new Map(counted.map((account) => [account.id, account])),
    file,
    pairs,
    history: {
      transactions: transactions.rows,
      counted: currencies,
      file,
      categories: categories.rows,
      budgets: heldBudgets,
      rates: heldRates,
      today,
    },
  };
}

export function money(minor: bigint | number, currency: string = NET_CURRENCY): string {
  return formatMinor(minor, currency, LOCALE);
}

export function amountText(amount: Amount): string {
  return amount.kind === 'summed' ? money(amount.minor) : 'not worked out';
}

/** "$40 left for 4 days", or "$40 left" when the month has no days after today. */
function leftFor(leftMinor: bigint, clock: MonthClock): string {
  const left = `${money(leftMinor)} left`;
  if (!clock.running || clock.daysLeft === 0) return left;
  return `${left} for ${clock.daysLeft === 1 ? '1 day' : `${clock.daysLeft} days`}`;
}

export const STANDING_NAMES: Readonly<Record<Standing, string>> = {
  over: 'Over budget',
  ahead: 'Ahead of pace',
  'on-track': 'On track',
};

/* ─── the page ──────────────────────────────────────────────────────────────────────────── */

export function Budget({
  month,
  userId,
}: {
  readonly month: string | null;
  readonly userId: string;
}) {
  const now = useNow();
  const today = localDay(now);
  const current = monthOf(today);
  const shown = month ?? current;
  const data = useBudgetMonth(shown, today);
  const online = useOnline();

  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed') return <Unreachable />;

  return (
    <section className="details budget" aria-labelledby="budget-title">
      <h2 id="budget-title">Budget</h2>
      <MonthNav shown={shown} current={current} href={budgetHref} />
      {data.categories.length === 0 ? (
        <Start
          unclaimed={unclaimedSources(data.transactions, data.categories)}
          userId={userId}
          online={online}
        />
      ) : (
        <MonthView
          data={data}
          clock={monthClock(shown, today)}
          current={current}
          userId={userId}
          online={online}
          selected={null}
        />
      )}
    </section>
  );
}

export function Unreachable() {
  return (
    <section className="details">
      <p className="muted">
        Dinora could not be reached, and this device has no transactions saved from before.
      </p>
    </section>
  );
}

/** The month before and after, as links to `href` of each; none past this month. */
export function MonthNav({
  shown,
  current,
  href,
}: {
  readonly shown: Month;
  readonly current: Month;
  /** Where a month is: this month without one, so the address stays this month's. */
  readonly href: (month?: Month) => string;
}) {
  const next = shiftMonth(shown, 1);
  return (
    <nav className="budget-nav" aria-label="Month">
      <a href={href(shiftMonth(shown, -1))} aria-label="The month before">
        ←
      </a>
      <span>{describeMonth(shown, LOCALE)}</span>
      {shown < current ? (
        <a href={next === current ? href() : href(next)} aria-label="The month after">
          →
        </a>
      ) : (
        <span aria-hidden="true" className="muted">
          →
        </span>
      )}
    </nav>
  );
}

/**
 * The month, its categories by what needs looking at, and the way to categories and rules. The
 * Budget tab's whole page, and on a wide window the list beside a category (`selected`).
 */
export function MonthView({
  data,
  clock,
  current,
  userId,
  online,
  selected,
}: {
  readonly data: BudgetMonth;
  readonly clock: MonthClock;
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
  /** The category open beside the list, marked in it. */
  readonly selected: string | null;
}) {
  const { summary } = data;
  const placed = byAttention(summary.spend, clock);
  // A budget changes from the month shown on, never for one already over.
  const budgetable = data.month >= current;
  const [setting, setSetting] = useState<CategoryRow | null>(null);
  const set = budgetable ? (category: CategoryRow) => setSetting(category) : null;
  const groups: readonly (readonly [Standing, readonly Placed[]])[] = [
    ['over', placed.over],
    ['ahead', placed.ahead],
    ['on-track', placed.onTrack],
  ];

  return (
    <>
      <Overview data={data} clock={clock} />
      {summary.unsorted.count > 0 && (
        <CategorizeCard count={summary.unsorted.count} month={data.month} current={current} />
      )}
      {groups.map(
        ([standing, list]) =>
          list.length > 0 && (
            <section
              key={standing}
              className="budget-group"
              aria-labelledby={`budget-group-${standing}`}
            >
              <h3 id={`budget-group-${standing}`} className="budget-group-head">
                {STANDING_NAMES[standing]}
              </h3>
              <ul className="budget-lines">
                {list.map((p) => (
                  <BudgetLine
                    key={p.line.category.id}
                    placed={p}
                    clock={clock}
                    month={data.month}
                    current={current}
                    selected={p.line.category.id === selected}
                    onSet={set}
                  />
                ))}
              </ul>
            </section>
          ),
      )}
      <GoalsInBudget data={data} current={current} userId={userId} online={online} />
      <Folds
        summary={summary}
        unbudgeted={placed.unbudgeted}
        month={data.month}
        current={current}
        selected={selected}
        onSet={set}
      />
      <SpendingCalendar data={data} current={current} userId={userId} online={online} />
      <p className="budget-manage">
        <a href={CATEGORIES_HREF}>Categories and rules</a>
      </p>
      <Sheet
        title={setting === null ? 'Budget' : `Budget for ${setting.name}`}
        open={setting !== null}
        onClose={() => setSetting(null)}
      >
        {setting !== null && (
          <BudgetForm
            category={setting}
            month={data.month}
            data={data}
            userId={userId}
            online={online}
            onSaved={() => setSetting(null)}
          />
        )}
      </Sheet>
    </>
  );
}

/* ─── how the month went ────────────────────────────────────────────────────────────────── */

/**
 * A share of a budget as a bar, full at the budget: red once over, amber ahead of the month's
 * pace. The tick is today, so a bar past its tick is spending faster than the month is going.
 */
export function SpendBar({
  tenths,
  standing,
  clock,
  label,
}: {
  readonly tenths: number;
  readonly standing: Standing | null;
  readonly clock: MonthClock;
  readonly label: string;
}) {
  return (
    <div className="spend-bar">
      <progress
        className={
          standing === 'over' || standing === 'ahead' ? `goal-bar ${standing}` : 'goal-bar'
        }
        max={1000}
        value={Math.min(tenths, 1000)}
        aria-label={label}
      />
      {clock.running && (
        <span className="pace-tick" style={{ left: `${clock.elapsed / 10}%` }} aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * The month's figure and how it stands, over its spending by day against an even pace (BUD-02).
 * The bar that was here is the one thing the line says better, so the line replaced it; each
 * category keeps its bar.
 */
function Overview({ data, clock }: { readonly data: BudgetMonth; readonly clock: MonthClock }) {
  const { summary } = data;
  const { spentMinor, budgetedMinor } = summary;
  const budgeted = budgetedMinor !== null && budgetedMinor > 0n ? budgetedMinor : null;
  const standing =
    spentMinor !== null && budgeted !== null ? standingOf(spentMinor, budgeted, clock) : null;
  return (
    <div className="budget-overview">
      <div className="hero-value">{spentMinor === null ? '—' : money(spentMinor)}</div>
      <p className="muted small">spent{budgeted !== null && ` of ${money(budgeted)} budgeted`}</p>
      {spentMinor !== null && budgeted !== null && standing !== null && (
        <p className="small">
          <span className={`standing ${standing}`}>
            {standing === 'over'
              ? `${money(spentMinor - budgeted)} over budget`
              : clock.running
                ? standing === 'ahead'
                  ? 'Ahead of pace'
                  : 'On pace'
                : 'Within budget'}
          </span>
          {standing !== 'over' && ` · ${leftFor(budgeted - spentMinor, clock)}`}
        </p>
      )}
      {spentMinor === null && (
        <p className="muted small">
          Not worked out: a transaction is in a currency with no rate into {summary.currency} yet.
        </p>
      )}
      <SpendingPace data={data} budgetedMinor={budgeted} standing={standing} />
      {summary.conversions.map((c) => (
        <p key={`${c.currency}:${c.rate.id}`} className="muted small">
          {c.currency} at {c.rate.rate} to the {summary.currency}, the ECB’s rate for{' '}
          {describeShortDay(c.rate.rate_date, LOCALE)}.
        </p>
      ))}
    </div>
  );
}

/**
 * Uncategorized is left out rather than counted as spent: a paycheck into checking has no
 * category either until it is given one, and would read as spending less.
 */
function CategorizeCard({
  count,
  month,
  current,
}: {
  readonly count: number;
  readonly month: Month;
  readonly current: Month;
}) {
  return (
    <div className="budget-categorize">
      <p>
        <strong>
          {count === 1 ? '1 transaction' : `${count} transactions`} without a category
        </strong>
        <span className="muted">Not counted until {count === 1 ? 'it has' : 'they have'} one</span>
      </p>
      <a
        className="button-link"
        href={month === current ? categorizeHref() : categorizeHref(month)}
      >
        Categorize {count}
      </a>
    </div>
  );
}

function lineNote(p: Placed, clock: MonthClock): string {
  const { line } = p;
  if (p.standing === null || line.budgetMinor === null || line.spent.kind !== 'summed') {
    return 'Not worked out';
  }
  const left = line.budgetMinor - line.spent.minor;
  return left < 0n ? `${money(-left)} over` : leftFor(left, clock);
}

function hrefFor(categoryId: string, month: Month, current: Month): string {
  return month === current ? categoryHref(categoryId) : categoryHref(categoryId, month);
}

/**
 * One category against its budget. The name opens its page, and the whole row with it; the
 * budget is its own button over the row, opening the budget sheet (Nora, 26 Sep: "Let them
 * straight from the list"). A month already over shows its budget and offers no change.
 */
function BudgetLine({
  placed,
  clock,
  month,
  current,
  selected,
  onSet,
}: {
  readonly placed: Placed;
  readonly clock: MonthClock;
  readonly month: Month;
  readonly current: Month;
  readonly selected: boolean;
  readonly onSet: ((category: CategoryRow) => void) | null;
}) {
  const { line } = placed;
  const { category } = line;
  const budget = line.budgetMinor === null ? 'a budget not worked out' : money(line.budgetMinor);
  return (
    <li className={selected ? 'budget-line selected' : 'budget-line'}>
      <div className="budget-line-head">
        <a
          className="budget-line-name"
          href={hrefFor(category.id, month, current)}
          aria-current={selected ? 'page' : undefined}
        >
          {category.name}
        </a>
        <span className="amount">{amountText(line.spent)}</span>
        {onSet === null ? (
          <span className="budget-line-budget muted">of {budget}</span>
        ) : (
          <button
            type="button"
            className="budget-line-budget"
            aria-label={`Budget for ${category.name}: ${budget}`}
            onClick={() => onSet(category)}
          >
            of {budget}
          </button>
        )}
      </div>
      {placed.share !== null && (
        <SpendBar
          tenths={placed.share}
          standing={placed.standing}
          clock={clock}
          label={`${category.name}, spent`}
        />
      )}
      <p className={placed.standing === 'over' ? 'budget-line-note over' : 'budget-line-note'}>
        {lineNote(placed, clock)}
      </p>
    </li>
  );
}

function sumOf(amounts: readonly Amount[]): bigint | null {
  let sum = 0n;
  for (const amount of amounts) {
    if (amount.kind !== 'summed') return null;
    sum += amount.minor;
  }
  return sum;
}

/** What needs no looking at most months, folded: categories with no budget, and money in. */
function Folds({
  summary,
  unbudgeted,
  month,
  current,
  selected,
  onSet,
}: {
  readonly summary: MonthSummary;
  readonly unbudgeted: readonly SpendLine[];
  readonly month: Month;
  readonly current: Month;
  readonly selected: string | null;
  readonly onSet: ((category: CategoryRow) => void) | null;
}) {
  const others = [...summary.income, ...summary.transfers];
  if (unbudgeted.length === 0 && others.length === 0) return null;
  const unbudgetedSum = sumOf(unbudgeted.map((line) => line.spent));
  return (
    <div className="budget-folds">
      {unbudgeted.length > 0 && (
        <details className="budget-fold" open={unbudgeted.some((l) => l.category.id === selected)}>
          <summary>
            <span>
              Without a budget <span className="muted">· {unbudgeted.length}</span>
            </span>
            <span className="amount">
              {unbudgetedSum === null ? 'not worked out' : money(unbudgetedSum)}
            </span>
          </summary>
          <ul className="budget-fold-list">
            {unbudgeted.map((line) => (
              <li key={line.category.id}>
                <a
                  className="budget-line-name"
                  href={hrefFor(line.category.id, month, current)}
                  aria-current={line.category.id === selected ? 'page' : undefined}
                >
                  {line.category.name}
                </a>
                <span className="amount muted">{amountText(line.spent)}</span>
                {onSet !== null && (
                  <button
                    type="button"
                    className="budget-line-budget"
                    aria-label={`Set a budget for ${line.category.name}`}
                    onClick={() => onSet(line.category)}
                  >
                    Set budget
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {others.length > 0 && (
        <details className="budget-fold" open={others.some((l) => l.category.id === selected)}>
          <summary>
            <span>Income and transfers</span>
            {summary.incomeMinor !== null && summary.incomeMinor !== 0n && (
              <span className="amount good">{money(summary.incomeMinor)} in</span>
            )}
          </summary>
          <ul className="budget-fold-list">
            {others.map((line) => (
              <li key={line.category.id}>
                <a
                  className="budget-line-name"
                  href={hrefFor(line.category.id, month, current)}
                  aria-current={line.category.id === selected ? 'page' : undefined}
                >
                  {line.category.name}{' '}
                  <span className="muted small">
                    {line.category.kind === 'income' ? 'Income' : 'Transfer, not counted as spent'}
                  </span>
                </a>
                <span className="amount muted">{amountText(line.net)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ─── the first start ───────────────────────────────────────────────────────────────────── */

function Start({
  unclaimed,
  userId,
  online,
}: {
  readonly unclaimed: readonly Unclaimed[];
  readonly userId: string;
  readonly online: boolean;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const starting = startingCategories(unclaimed);

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await addCategories(userId, starting);
      await client.invalidateQueries({ queryKey: CATEGORIES.queryKey });
    } catch (error) {
      setProblem(notDone(error, 'saved'));
      setBusy(false);
    }
  };

  return (
    <div className="budget-start">
      <p>No categories yet. They are yours, not the bank’s: Monarch’s are only a first guess.</p>
      {starting.length > 0 && (
        <>
          <p className="muted small">
            Start from the {starting.length} categories Monarch used in your history (
            {starting
              .slice(0, 5)
              .map((c) => c.name)
              .join(', ')}
            {starting.length > 5 ? ', …' : ''}). Each takes Monarch’s guesses under its name, and
            you can rename, merge or remove any of them.
          </p>
          <button type="button" disabled={!online || busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start from Monarch’s categories'}
          </button>
        </>
      )}
      <h3>New category</h3>
      <AddCategory userId={userId} online={online} />
      {problem !== null && (
        <p className="error small" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/* ─── elsewhere ─────────────────────────────────────────────────────────────────────────── */

/** "$1,240.00 spent of $2,000.00 budgeted", the dashboard's one line for this month. */
export function monthLine(summary: MonthSummary): string {
  const { spentMinor, budgetedMinor } = summary;
  if (spentMinor === null) return 'Not worked out yet';
  const spent = `${money(spentMinor)} spent`;
  const line =
    budgetedMinor !== null && budgetedMinor > 0n
      ? `${spent} of ${money(budgetedMinor)} budgeted`
      : spent;
  const unsorted = summary.unsorted.count;
  return unsorted === 0 ? line : `${line} · ${unsorted} to categorize`;
}
