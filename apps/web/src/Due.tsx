import type { Due } from '@dinora/core/due';
import { describeDayWithYear } from '@dinora/core/networth';
import { formatRate } from '@dinora/core/terms';

import { accountHref, goalHref } from './route.ts';
import { LOCALE } from './time.tsx';

/**
 * What is due (ACCT-15), above net worth: a promo ending and a goal's date, soonest first.
 * Nothing at all while nothing is due, so the first screen is no longer for it on most days.
 *
 * Above the figure rather than beside the goals it partly repeats, because it sits with the
 * last-read line and its warnings: each is a thing only she can act on, and each has a date.
 */
export function DueSoon({ due }: { readonly due: readonly Due[] }) {
  if (due.length === 0) return null;
  return (
    <section className="group due" aria-labelledby="due-title">
      <div className="group-head">
        <h2 id="due-title">
          <span>Coming up</span>
        </h2>
      </div>
      <ul className="accounts">
        {due.map((item) =>
          item.kind === 'promo' ? (
            <Promo key={`promo-${item.account.id}`} item={item} />
          ) : (
            <Goal key={`goal-${item.goal.id}`} item={item} />
          ),
        )}
      </ul>
    </section>
  );
}

function Promo({ item }: { readonly item: Extract<Due, { kind: 'promo' }> }) {
  const passed = item.daysLeft <= 0;
  const then = item.thenBp === null ? null : formatRate(item.thenBp);
  return (
    <li>
      <div className="account">
        <span>
          <a href={accountHref(item.account.id)}>{item.account.name || 'Unnamed account'}</a>
        </span>
        <span className="muted small">
          {formatRate(item.rateBp)} promo APR
          {passed ? ' ended' : ' ends'} <When on={item.on} />
          {then !== null && (passed ? `, now ${then}` : `, then ${then}`)}
        </span>
      </div>
      <div className={item.soon && !passed ? 'amount error' : 'amount muted'}>
        <Left days={item.daysLeft} />
      </div>
    </li>
  );
}

function Goal({ item }: { readonly item: Extract<Due, { kind: 'goal' }> }) {
  const passed = item.daysLeft <= 0;
  const pace = passed
    ? ', not reached'
    : item.onPace === true
      ? ', on pace'
      : item.onPace === false
        ? ', behind pace'
        : '';
  return (
    <li>
      <div className="account">
        <span>
          <a href={goalHref(item.goal.id)}>{item.goal.name}</a>
        </span>
        <span className="muted small">
          {passed ? 'Was due' : 'Due'} <When on={item.on} />
          {pace}
        </span>
      </div>
      <div className={passed || item.onPace === false ? 'amount error' : 'amount muted'}>
        <Left days={item.daysLeft} />
      </div>
    </li>
  );
}

function When({ on }: { readonly on: string }) {
  return <time dateTime={on}>{describeDayWithYear(on, LOCALE)}</time>;
}

function Left({ days }: { readonly days: number }) {
  if (days === 0) return <>today</>;
  const count = Math.abs(days);
  const unit = count === 1 ? 'day' : 'days';
  return <>{days > 0 ? `in ${count} ${unit}` : `${count} ${unit} ago`}</>;
}
