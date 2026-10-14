import type { CategoryRow } from '@dinora/core/budgets';
import { budgetFor, CATEGORY_KINDS, monthOf } from '@dinora/core/budgets';
import { categoriesInUse } from '@dinora/core/pace';
import { rulesIn } from '@dinora/core/budgets';
import { rulesMadeIn } from '@dinora/core/sorting';
import { useState } from 'react';

import { money, Unreachable, useBudgetMonth } from './Budget.tsx';
import { AddCategory } from './CategoryForms.tsx';
import { useOnline } from './device/useOnline.ts';
import { BUDGET_HREF, categoryHref, RULES_HREF } from './route.ts';
import { Sheet } from './sheet.tsx';
import { localDay, useNow } from './time.tsx';

const KIND_HEADS = { spend: 'Spending', income: 'Income', transfer: 'Transfers' } as const;

/**
 * Every category, and the way to the rules (UI-11): setting up, not something looked at each
 * month, so it is off the month's page. Each opens its own page, where it is changed. One that
 * nothing has ever been filed under sinks to the foot of its kind (Nora, 26 Sep).
 */
export function Categories({ userId }: { readonly userId: string }) {
  const now = useNow();
  const today = localDay(now);
  const current = monthOf(today);
  const data = useBudgetMonth(current, today);
  const online = useOnline();
  const [adding, setAdding] = useState(false);

  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed') return <Unreachable />;

  const used = categoriesInUse(data.transactions, data.file);
  const inForce = rulesIn(current, data.rules);
  const made = rulesMadeIn(current, inForce);
  const byName = (a: CategoryRow, b: CategoryRow) => a.name.localeCompare(b.name);

  return (
    <section className="details categories" aria-labelledby="categories-title">
      <p>
        <a className="back" href={BUDGET_HREF}>
          ‹ Budget
        </a>
      </p>
      <div className="section-head">
        <h2 id="categories-title">Categories</h2>
        <button type="button" className="secondary small-action" onClick={() => setAdding(true)}>
          New category
        </button>
      </div>
      {data.categories.length === 0 && (
        <p className="muted">No categories yet. The Budget tab offers Monarch’s as a start.</p>
      )}
      {CATEGORY_KINDS.map((kind) => {
        const ofKind = data.categories.filter((c) => c.kind === kind);
        if (ofKind.length === 0) return null;
        const sorted = [
          ...ofKind.filter((c) => used.has(c.id)).sort(byName),
          ...ofKind.filter((c) => !used.has(c.id)).sort(byName),
        ];
        return (
          <section key={kind} className="card-list" aria-labelledby={`kind-${kind}`}>
            <h3 id={`kind-${kind}`} className="budget-group-head">
              {KIND_HEADS[kind]} <span className="muted">· {ofKind.length}</span>
            </h3>
            <ul>
              {sorted.map((category) => {
                const unused = !used.has(category.id);
                const budget =
                  kind === 'spend' ? budgetFor(category.id, current, data.budgets) : null;
                return (
                  <li key={category.id} className={unused ? 'unused' : undefined}>
                    <a className="link-row" href={categoryHref(category.id)}>
                      <span>{category.name}</span>
                      <span className="muted small">
                        {unused
                          ? 'No transactions'
                          : kind !== 'spend'
                            ? ''
                            : budget === null
                              ? 'No budget'
                              : `${money(budget.amountMinor, budget.row.currency)} a month`}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <section className="card-list" aria-labelledby="rules-head">
        <h3 id="rules-head" className="budget-group-head">
          Rules
        </h3>
        {inForce.length === 0 ? (
          <p className="muted small">
            None yet. Categorizing a transaction offers to make one for its payee.
          </p>
        ) : (
          <ul>
            <li>
              <a className="link-row" href={RULES_HREF}>
                <span>{inForce.length === 1 ? '1 rule' : `${inForce.length} rules`}</span>
                <span className="muted small">
                  {made === 1 ? '1 made this month' : `${made} made this month`}
                </span>
              </a>
            </li>
          </ul>
        )}
      </section>
      <Sheet title="New category" open={adding} onClose={() => setAdding(false)}>
        <AddCategory userId={userId} online={online} onAdded={() => setAdding(false)} />
      </Sheet>
    </section>
  );
}
