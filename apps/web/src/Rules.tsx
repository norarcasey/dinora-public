import type { RuleRow } from '@dinora/core/budgets';
import { describeMonth, monthOf } from '@dinora/core/budgets';
import { findRules, recentCategories, rulesMadeIn, rulesNewestFirst } from '@dinora/core/sorting';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { BudgetMonth } from './Budget.tsx';
import { Unreachable, useBudgetMonth } from './Budget.tsx';
import { useOnline } from './device/useOnline.ts';
import { addRule, CATEGORY_RULES } from './queries/budgets.ts';
import { notDone } from './queries/writes.ts';
import { CATEGORIES_HREF, payeeHref } from './route.ts';
import { Sheet } from './sheet.tsx';
import { CategoryPicker } from './Sorting.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

/** How many the list shows before a search: the newest, where a rule to fix usually is. */
const NEWEST = 20;

const RECENT = 6;

/**
 * The rules in force (UI-11), found by typing. Nora, 26 Sep: she travels, will make a rule for
 * most payees, "and will almost never look at them except to fix the occasional one". So the
 * newest few, a search by payee and a filter by category, and one opened to change or stop.
 */
export function Rules({
  categoryId,
  userId,
}: {
  readonly categoryId: string | null;
  readonly userId: string;
}) {
  const now = useNow();
  const today = localDay(now);
  const current = monthOf(today);
  const data = useBudgetMonth(current, today);
  const online = useOnline();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(categoryId ?? '');
  const [open, setOpen] = useState<RuleRow | null>(null);

  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed') return <Unreachable />;

  const inForce = rulesNewestFirst(current, data.rules);
  const made = rulesMadeIn(current, inForce);
  const names = new Map(data.categories.map((c) => [c.id, c.name]));
  const filed = new Set(inForce.map((r) => r.category_id));
  const choices = data.categories
    .filter((c) => filed.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const searching = query.trim() !== '' || filter !== '';
  const found = findRules(query, filter === '' ? null : filter, inForce);
  const listed = searching ? found : found.slice(0, NEWEST);

  return (
    <section className="details rules" aria-labelledby="rules-title">
      <p>
        <a className="back" href={CATEGORIES_HREF}>
          ‹ Categories
        </a>
      </p>
      <h2 id="rules-title">Rules</h2>
      <p className="muted small">
        {inForce.length === 1 ? '1 rule' : `${inForce.length} rules`} · {made} made this month
      </p>
      <div className="rules-find">
        <input
          type="search"
          aria-label="Find a rule by payee"
          placeholder="Payee"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <select
          aria-label="Category"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        >
          <option value="">Every category</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <h3 className="budget-group-head">
        {searching ? (found.length === 1 ? '1 rule' : `${found.length} rules`) : 'Newest'}
      </h3>
      {listed.length === 0 ? (
        <p className="muted small">
          {inForce.length === 0
            ? 'None yet. Categorizing a transaction offers to make one for its payee.'
            : 'No rule for a payee like that.'}
        </p>
      ) : (
        <ul className="card-list-items rules-list">
          {listed.map((rule) => (
            <li key={rule.id}>
              <button type="button" className="link-row" onClick={() => setOpen(rule)}>
                <span className="rule-payee">“{rule.payee}”</span>
                <span className="muted small">
                  {names.get(rule.category_id ?? '') ?? 'A removed category'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!searching && found.length > NEWEST && (
        <p className="muted small">And {found.length - NEWEST} more: type to find one.</p>
      )}
      <p className="muted small">
        A wrong one is usually quicker to fix from a transaction it filed: choose another category
        there, and it offers a new rule.
      </p>
      <Sheet
        title={open === null ? 'Rule' : `“${open.payee}”`}
        open={open !== null}
        onClose={() => setOpen(null)}
      >
        {open !== null && (
          <RuleSheet
            rule={open}
            data={data}
            current={current}
            userId={userId}
            online={online}
            onDone={() => setOpen(null)}
          />
        )}
      </Sheet>
    </section>
  );
}

/**
 * One rule: where it files and since when, and its two changes. Each is a newer rule from this
 * month, so the months it already filed keep what it filed (BUD-01).
 */
function RuleSheet({
  rule,
  data,
  current,
  userId,
  online,
  onDone,
}: {
  readonly rule: RuleRow;
  readonly data: BudgetMonth;
  readonly current: string;
  readonly userId: string;
  readonly online: boolean;
  readonly onDone: () => void;
}) {
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const category = data.categories.find((c) => c.id === rule.category_id);

  const change = async (categoryId: string | null) => {
    setBusy(true);
    setProblem(null);
    try {
      await addRule(userId, rule.payee, categoryId, current);
      await client.invalidateQueries({ queryKey: CATEGORY_RULES.queryKey });
      onDone();
    } catch (error) {
      setProblem(notDone(error, 'saved'));
      setBusy(false);
    }
  };

  if (picking) {
    return (
      <CategoryPicker
        currentId={rule.category_id}
        categories={data.categories}
        recent={recentCategories(data.choices, data.categories, RECENT)}
        onPick={(id) => void change(id)}
      />
    );
  }

  const off = !online || busy;
  return (
    <div className="stack">
      <p>
        Files into <strong>{category?.name ?? 'a removed category'}</strong> since{' '}
        {describeMonth(monthOf(rule.starts_on), LOCALE)}.
      </p>
      <p className="small">
        <a href={payeeHref(rule.payee)}>See its transactions</a>
      </p>
      <button type="button" disabled={off} onClick={() => setPicking(true)}>
        Change category
      </button>
      <button
        type="button"
        className="quiet danger"
        aria-label={`Stop the rule for ${rule.payee}`}
        disabled={off}
        onClick={() => void change(null)}
      >
        Stop this rule
      </button>
      <p className="muted small">
        Either starts from {describeMonth(current, LOCALE)}. The months before keep what the rule
        filed.
      </p>
      {problem !== null && (
        <p className="error small" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
