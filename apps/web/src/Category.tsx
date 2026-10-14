import type { CategoryRow, Month } from '@dinora/core/budgets';
import {
  describeMonth,
  monthOf,
  rulesIn,
  spentShare,
  unclaimedSources,
} from '@dinora/core/budgets';
import type { MonthClock } from '@dinora/core/pace';
import { monthClock, spentBefore, standingOf } from '@dinora/core/pace';
import { byDay, describeWeekday, rulesMadeIn } from '@dinora/core/sorting';
import { useState, useSyncExternalStore } from 'react';

import type { BudgetMonth } from './Budget.tsx';
import {
  amountText,
  money,
  MonthNav,
  MonthView,
  SpendBar,
  Unreachable,
  useBudgetMonth,
} from './Budget.tsx';
import { BudgetForm, EditCategory, KIND_NAMES, shortMonth } from './CategoryForms.tsx';
import { useOnline } from './device/useOnline.ts';
import { budgetHref, CATEGORIES_HREF, categoryHref, rulesHref } from './route.ts';
import { Sheet } from './sheet.tsx';
import { accountMeta, FilingRow, OriginKey, usePicker } from './Sorting.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

/** How many months before this one the page names what the category spent. */
const PAST_MONTHS = 3;

/**
 * Wide enough to keep the month's list beside the category, as the Mac window is: choosing a
 * category then changes the right side and leaves the list where it was.
 */
const WIDE = '(min-width: 900px)';

function subscribeWide(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function isWide(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches;
}

/**
 * One category's month (UI-11): what it spent against its budget, every transaction filed in it,
 * and the rules that file there. Read first; its budget, and its name, kind and guesses, are
 * changed in sheets, as an asset's and a goal's are (UI-03).
 */
export function Category({
  categoryId,
  month,
  userId,
}: {
  readonly categoryId: string;
  readonly month: string | null;
  readonly userId: string;
}) {
  const now = useNow();
  const today = localDay(now);
  const current = monthOf(today);
  const shown = month ?? current;
  const data = useBudgetMonth(shown, today);
  const online = useOnline();
  const wide = useSyncExternalStore(subscribeWide, isWide, () => false);

  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed') return <Unreachable />;
  const clock = monthClock(shown, today);

  const page = (
    <CategoryPage
      categoryId={categoryId}
      data={data}
      clock={clock}
      current={current}
      userId={userId}
      online={online}
    />
  );
  if (!wide) return page;
  return (
    <div className="budget-split">
      <section className="details budget" aria-label={`Budget, ${describeMonth(shown, LOCALE)}`}>
        <MonthNav shown={shown} current={current} href={budgetHref} />
        <MonthView
          data={data}
          clock={clock}
          current={current}
          userId={userId}
          online={online}
          selected={categoryId}
        />
      </section>
      {page}
    </div>
  );
}

function CategoryPage({
  categoryId,
  data,
  clock,
  current,
  userId,
  online,
}: {
  readonly categoryId: string;
  readonly data: BudgetMonth;
  readonly clock: MonthClock;
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [setting, setSetting] = useState(false);
  const picker = usePicker(data);
  // Rows filed away from this category stay in its list, so the rule question and any refusal
  // stay on screen with them.
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const shown = data.month;
  const back = shown === current ? budgetHref() : budgetHref(shown);
  const category = data.categories.find((c) => c.id === categoryId);

  if (category === undefined) {
    return (
      <section className="details">
        <p>
          <a className="back" href={back}>
            ‹ Budget
          </a>
        </p>
        <p className="muted">This category was removed. What it held is filed without it.</p>
      </section>
    );
  }

  const entries = data.entries.filter(
    (entry) =>
      kept.has(entry.transaction.id) ||
      (entry.filed.kind !== 'none' && entry.filed.category.id === category.id),
  );
  const inForce = rulesIn(current, data.rules).filter((r) => r.category_id === category.id);
  const made = rulesMadeIn(current, inForce);

  return (
    <section className="details category" aria-labelledby="category-title">
      <div className="category-top">
        <a className="back" href={back}>
          ‹ Budget
        </a>
        <button type="button" className="secondary small-action" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      <h2 id="category-title">{category.name}</h2>
      <p className="muted small">
        {KIND_NAMES[category.kind]}
        {category.kind === 'transfer' && ', not counted as spent'}
      </p>
      <MonthNav
        shown={shown}
        current={current}
        href={(month) => categoryHref(category.id, month)}
      />

      {category.kind === 'spend' ? (
        <Spent
          category={category}
          data={data}
          clock={clock}
          budgetable={shown >= current}
          onSet={() => setSetting(true)}
        />
      ) : (
        <Moved category={category} data={data} />
      )}

      <section className="category-entries" aria-labelledby="category-entries-title">
        <h3 id="category-entries-title">
          Transactions{' '}
          <span className="muted small">
            {entries.length === 1 ? '1 transaction' : `${entries.length} transactions`}
          </span>
        </h3>
        {entries.length === 0 ? (
          <p className="muted small">None filed here in {describeMonth(shown, LOCALE)}.</p>
        ) : (
          <>
            <OriginKey />
            {byDay(entries).map(({ day, entries: onDay }) => (
              <section key={day} className="budget-day" aria-label={describeWeekday(day, LOCALE)}>
                <h4 className="day-head">{describeWeekday(day, LOCALE)}</h4>
                <ul className="accounts">
                  {onDay.map((entry) => (
                    <FilingRow
                      key={entry.transaction.id}
                      entry={entry}
                      meta={accountMeta(
                        data.accounts.get(entry.transaction.account_id),
                        entry.transaction,
                      )}
                      data={data}
                      current={current}
                      userId={userId}
                      online={online}
                      onOpen={picker.open}
                      onFiled={() => setKept((before) => new Set(before).add(entry.transaction.id))}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </section>

      {inForce.length > 0 && (
        <a className="link-row" href={rulesHref(category.id)}>
          <span>
            {inForce.length === 1 ? '1 rule files here' : `${inForce.length} rules file here`}
            {made > 0 && (
              <span className="muted small">
                {made === 1 ? '1 made this month' : `${made} made this month`}
              </span>
            )}
          </span>
        </a>
      )}
      <p className="budget-manage">
        <a href={CATEGORIES_HREF}>Categories and rules</a>
      </p>

      {picker.sheet}
      <Sheet title={`Budget for ${category.name}`} open={setting} onClose={() => setSetting(false)}>
        <BudgetForm
          category={category}
          month={shown}
          data={data}
          userId={userId}
          online={online}
          onSaved={() => setSetting(false)}
        />
      </Sheet>
      <Sheet title={`Edit ${category.name}`} open={editing} onClose={() => setEditing(false)}>
        <EditCategory
          category={category}
          unclaimed={unclaimedSources(data.transactions, data.categories)}
          online={online}
          onSaved={() => setEditing(false)}
          onRemoved={() => {
            setEditing(false);
            window.location.hash = CATEGORIES_HREF;
          }}
        />
      </Sheet>
    </section>
  );
}

/** A spending category's month against its budget, and the months before. */
function Spent({
  category,
  data,
  clock,
  budgetable,
  onSet,
}: {
  readonly category: CategoryRow;
  readonly data: BudgetMonth;
  readonly clock: MonthClock;
  readonly budgetable: boolean;
  readonly onSet: () => void;
}) {
  const line = data.summary.spend.find((l) => l.category.id === category.id);
  const spent = line?.spent ?? { kind: 'summed', minor: 0n };
  const budgeted = line !== undefined && line.budget !== null;
  const budgetMinor = line?.budgetMinor ?? null;
  const worked = spent.kind === 'summed' && budgetMinor !== null;
  const share = worked ? spentShare(spent.minor, budgetMinor) : null;
  const standing = worked ? standingOf(spent.minor, budgetMinor, clock) : null;
  const past = spentBefore(category.id, data.month, PAST_MONTHS, data.history);
  const left = worked ? budgetMinor - spent.minor : null;

  return (
    <div className="category-spent">
      <div className="hero-value">{amountText(spent)}</div>
      <p className="muted small">
        {budgetMinor !== null
          ? `spent of ${money(budgetMinor)}`
          : budgeted
            ? 'spent, of a budget not worked out'
            : 'spent, with no budget'}
      </p>
      {share !== null && (
        <SpendBar
          tenths={share}
          standing={standing}
          clock={clock}
          label={`${category.name}, spent`}
        />
      )}
      {left !== null && (
        <p className={left < 0n ? 'small standing over' : 'small'}>
          {left < 0n
            ? `${money(-left)} over${clock.running && clock.daysLeft > 0 ? `, with ${clock.daysLeft === 1 ? '1 day' : `${clock.daysLeft} days`} to go` : ''}`
            : `${money(left)} left`}
        </p>
      )}
      <div className="category-budget">
        {budgetable && (
          <button type="button" className="secondary small-action" onClick={onSet}>
            {budgeted ? 'Set budget' : 'Set a budget'}
          </button>
        )}
        <p className="muted small">
          {past.map((p) => `${shortMonth(p.month)} ${amountText(p.spent)}`).join(' · ')}
        </p>
      </div>
    </div>
  );
}

/** An income or transfer category's month: what moved, with no budget to set. */
function Moved({ category, data }: { readonly category: CategoryRow; readonly data: BudgetMonth }) {
  const line = [...data.summary.income, ...data.summary.transfers].find(
    (l) => l.category.id === category.id,
  );
  return (
    <div className="category-spent">
      <div className="hero-value">{line === undefined ? money(0) : amountText(line.net)}</div>
      <p className="muted small">{category.kind === 'income' ? 'came in' : 'moved'}</p>
    </div>
  );
}
