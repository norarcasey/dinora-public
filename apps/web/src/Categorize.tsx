import { describeMonth, monthOf } from '@dinora/core/budgets';
import { recentCategories } from '@dinora/core/sorting';

import { Unreachable, useBudgetMonth } from './Budget.tsx';
import { useOnline } from './device/useOnline.ts';
import { budgetHref } from './route.ts';
import { CategorizeQueue } from './Sorting.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

/** How many of her recent choices the queue offers before the full list. */
const RECENT = 6;

/**
 * A month's uncategorized transactions one at a time (UI-08), on a page of its own since UI-11:
 * it was a filter over the budget page's list, which is gone from there.
 */
export function Categorize({
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
  const back = shown === current ? budgetHref() : budgetHref(shown);

  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed') return <Unreachable />;

  return (
    <section className="details categorize" aria-labelledby="categorize-title">
      <p>
        <a className="back" href={back}>
          ‹ Budget
        </a>
      </p>
      <h2 id="categorize-title">Categorize</h2>
      <p className="muted small">{describeMonth(shown, LOCALE)}</p>
      <CategorizeQueue
        data={data}
        recent={recentCategories(data.choices, data.categories, RECENT)}
        current={current}
        userId={userId}
        online={online}
        onDone={() => {
          window.location.hash = back;
        }}
      />
    </section>
  );
}
