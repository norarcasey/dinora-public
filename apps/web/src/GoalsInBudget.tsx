import { formatMinor } from '@dinora/core/balances';
import type { Month } from '@dinora/core/budgets';
import { dayOf, describeMonth, payeeName, shiftMonth } from '@dinora/core/budgets';
import type { GoalMonth, GoalPlanRow } from '@dinora/core/contributions';
import { givenShare, goalMonth, goalsIn } from '@dinora/core/contributions';
import type { GoalAccountRow } from '@dinora/core/goals';
import { describeShortDay } from '@dinora/core/networth';
import type { RateRow } from '@dinora/core/rates';
import { parseLimit } from '@dinora/core/terms';
import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useState } from 'react';

import type { BudgetMonth } from './Budget.tsx';
import type { Problem } from './controls.tsx';
import { Actions, amountDraft, currencyAffix, errorFor, Field, formError } from './controls.tsx';
import { shortMonth } from './CategoryForms.tsx';
import { ACCOUNTS, FX_RATES } from './queries/balances.ts';
import { GOAL_ACCOUNTS, GOAL_PLANS, GOALS, setPlan } from './queries/goals.ts';
import { useSynced } from './queries/synced.ts';
import { notDone } from './queries/writes.ts';
import { goalHref } from './route.ts';
import { Sheet } from './sheet.tsx';
import { LOCALE } from './time.tsx';

/*
 * Goals in the monthly budget (GOAL-04): what each goal was given this month, beside the
 * categories, against what she planned. What counts as given is decided in
 * `packages/core/src/contributions.ts`; this is the list and the one sheet a goal opens.
 */

/** How many months before the shown one the plan sheet offers to set a plan from. */
const PAST_MONTHS = 3;

type Held = {
  readonly links: readonly GoalAccountRow[];
  readonly plans: readonly GoalPlanRow[];
  readonly rates: readonly RateRow[];
  readonly currencies: ReadonlyMap<string, string>;
};

function useGoalMonths(
  data: BudgetMonth,
  today: string,
): { readonly months: readonly GoalMonth[]; readonly held: Held } {
  const goals = useSynced(GOALS);
  const links = useSynced(GOAL_ACCOUNTS);
  const plans = useSynced(GOAL_PLANS);
  const accounts = useSynced(ACCOUNTS);
  const rates = useSynced(FX_RATES);
  const held: Held = {
    links: links.status === 'held' ? links.rows : [],
    plans: plans.status === 'held' ? plans.rows : [],
    rates: rates.status === 'held' ? rates.rows : [],
    // Every account she has, not only the budget's: a goal's loan or brokerage is read too.
    currencies: new Map(
      (accounts.status === 'held' ? accounts.rows : []).map((a) => [a.id, a.currency] as const),
    ),
  };
  const months = goalsIn(
    data.month,
    goals.status === 'held' ? goals.rows : [],
    held.links,
    data.transactions,
    held.currencies,
    data.file,
    data.pairs,
    held.plans,
    held.rates,
    today,
  );
  return { months, held };
}

function given(month: GoalMonth): string {
  return month.given.kind === 'summed'
    ? formatMinor(month.given.minor, month.goal.currency, LOCALE)
    : 'not worked out';
}

/** Under the bar: how it stands against the plan, or what was given with none. */
function goalNote(month: GoalMonth): string {
  const { given: amount, plan, goal } = month;
  if (amount.kind !== 'summed') {
    return `Not worked out: no rate into ${goal.currency} yet`;
  }
  const money = (minor: bigint) => formatMinor(minor, goal.currency, LOCALE);
  if (amount.minor < 0n) return `${money(-amount.minor)} more taken out than put in`;
  if (plan === null) {
    return month.contributions.length === 0 ? 'Nothing moved in yet' : 'No plan';
  }
  const left = BigInt(plan.amountMinor) - amount.minor;
  if (left > 0n) return `${money(left)} to go`;
  return left === 0n ? 'Plan met' : `Plan met, and ${money(-left)} more`;
}

/**
 * The month's goals, as a group beside the categories' (Nora, 26 Sep: "how Goals fit into
 * monthly budgets"). Nothing when she has no goal. A row opens its sheet: what counted, and
 * the plan from this month on while the month is not over.
 */
export function GoalsInBudget({
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
  const today = data.history.today;
  const { months, held } = useGoalMonths(data, today);
  const [open, setOpen] = useState<string | null>(null);
  const plannable = data.month >= current;
  const shown = months.find((m) => m.goal.id === open) ?? null;
  if (months.length === 0) return null;

  return (
    <section className="budget-group" aria-labelledby="budget-group-goals">
      <h3 id="budget-group-goals" className="budget-group-head">
        Goals
      </h3>
      <ul className="budget-lines">
        {months.map((month) => {
          const { goal, plan } = month;
          const share =
            plan === null || month.given.kind !== 'summed'
              ? null
              : givenShare(month.given.minor, plan.amountMinor);
          const planned =
            plan === null ? null : formatMinor(plan.amountMinor, goal.currency, LOCALE);
          return (
            <li key={goal.id} className="budget-line">
              <div className="budget-line-head">
                <button
                  type="button"
                  className="budget-line-name goal-line-open"
                  onClick={() => setOpen(goal.id)}
                >
                  {goal.name}
                </button>
                <span className="amount">{given(month)}</span>
                {planned === null ? (
                  plannable && (
                    <button
                      type="button"
                      className="budget-line-budget"
                      aria-label={`Set a plan for ${goal.name}`}
                      onClick={() => setOpen(goal.id)}
                    >
                      Set plan
                    </button>
                  )
                ) : (
                  <span className="budget-line-budget muted">of {planned}</span>
                )}
              </div>
              {share !== null && (
                <div className="spend-bar">
                  <progress
                    className="goal-bar"
                    max={1000}
                    value={Math.min(share, 1000)}
                    aria-label={`${goal.name}, given`}
                  />
                </div>
              )}
              <p className="budget-line-note">{goalNote(month)}</p>
            </li>
          );
        })}
      </ul>
      <Sheet
        title={
          shown === null ? 'Goal' : `${shown.goal.name} in ${describeMonth(data.month, LOCALE)}`
        }
        open={shown !== null}
        onClose={() => setOpen(null)}
      >
        {shown !== null && (
          <GoalSheet
            month={shown}
            data={data}
            held={held}
            plannable={plannable}
            today={today}
            userId={userId}
            online={online}
            onSaved={() => setOpen(null)}
          />
        )}
      </Sheet>
    </section>
  );
}

function GoalSheet({
  month,
  data,
  held,
  plannable,
  today,
  userId,
  online,
  onSaved,
}: {
  readonly month: GoalMonth;
  readonly data: BudgetMonth;
  readonly held: Held;
  readonly plannable: boolean;
  readonly today: string;
  readonly userId: string;
  readonly online: boolean;
  readonly onSaved: () => void;
}) {
  const { goal } = month;
  return (
    <div className="goal-sheet">
      <p className="muted small">
        What moved into its accounts from your others, filed as a transfer. New charges, refunds,
        interest and a market’s moves change the balance, not what it was given.
      </p>
      {month.contributions.length === 0 ? (
        <p className="muted">Nothing moved in or out this month.</p>
      ) : (
        <ul className="accounts">
          {month.contributions.map((c) => (
            <li key={c.transaction.id} className="entry">
              <div className="account">
                <span>{payeeName(c.transaction)}</span>
                <span className="muted small">
                  {[
                    describeShortDay(c.day, LOCALE),
                    c.partner === null
                      ? 'no other side found'
                      : `other side ${payeeName(c.partner)}, ${describeShortDay(dayOf(c.partner, today), LOCALE)}`,
                  ].join(' · ')}
                </span>
              </div>
              <div className="entry-side">
                <span className="amount">
                  {formatMinor(c.transaction.amount_minor, c.currency, LOCALE)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {month.conversions.map((c) => (
        <p key={`${c.currency}:${c.rate.id}`} className="muted small">
          {c.currency} at {c.rate.rate} to the {goal.currency}, the ECB’s rate for{' '}
          {describeShortDay(c.rate.rate_date, LOCALE)}.
        </p>
      ))}
      {plannable ? (
        <PlanForm
          month={month}
          data={data}
          held={held}
          today={today}
          userId={userId}
          online={online}
          onSaved={onSaved}
        />
      ) : (
        month.plan !== null && (
          <p className="muted small">
            Planned {formatMinor(month.plan.amountMinor, goal.currency, LOCALE)} this month.
          </p>
        )
      )}
      <p className="budget-manage">
        <a href={goalHref(goal.id)}>Open {goal.name}</a>
      </p>
    </div>
  );
}

type ReadPlan =
  | { readonly ok: true; readonly minor: number | null }
  | { readonly ok: false; readonly problem: Problem<'plan'> };

/** A plan as typed: an amount in the goal's currency, or empty for none. */
export function readPlan(text: string, currency: string): ReadPlan {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, minor: null };
  const minor = parseLimit(trimmed, currency);
  return minor === null
    ? {
        ok: false,
        problem: {
          field: 'plan',
          message: 'Enter the plan as a number, like 500, or leave it empty.',
        },
      }
    : { ok: true, minor };
}

/**
 * The plan from this month on, with what the goal was given in the months before to set it
 * from, as a category's budget sheet offers what it spent.
 */
function PlanForm({
  month,
  data,
  held,
  today,
  userId,
  online,
  onSaved,
}: {
  readonly month: GoalMonth;
  readonly data: BudgetMonth;
  readonly held: Held;
  readonly today: string;
  readonly userId: string;
  readonly online: boolean;
  readonly onSaved: () => void;
}) {
  const client = useQueryClient();
  const { goal, plan } = month;
  const before = plan === null ? '' : amountDraft(plan.amountMinor, goal.currency);
  const [text, setText] = useState(before);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem<'plan'> | null>(null);
  const offers = Array.from({ length: PAST_MONTHS }, (_, i) =>
    shiftMonth(data.month, i - PAST_MONTHS),
  ).flatMap((past) => {
    const then = goalMonth(
      goal,
      past,
      held.links,
      data.transactions,
      held.currencies,
      data.file,
      data.pairs,
      held.plans,
      held.rates,
      today,
    );
    return then.given.kind === 'summed' && then.given.minor > 0n
      ? [{ label: shortMonth(past), minor: then.given.minor }]
      : [];
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readPlan(text, goal.currency);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    if (text.trim() === before.trim()) {
      onSaved();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await setPlan(userId, goal.id, data.month, read.minor, held.plans);
      await client.invalidateQueries({ queryKey: GOAL_PLANS.queryKey });
      onSaved();
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setBusy(false);
    }
  };

  const off = !online || busy;
  return (
    <form className="add-figure budget-form" onSubmit={(event) => void submit(event)}>
      <div className="fields">
        <Field
          label="Plan each month"
          hint={`From ${describeMonth(data.month, LOCALE)} on. Leave it empty for no plan.`}
          error={errorFor(problem, 'plan')}
          {...currencyAffix(goal.currency)}
        >
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={text}
              placeholder="None"
              disabled={off}
              data-autofocus
              onChange={(event) => {
                setText(event.currentTarget.value);
                setProblem(null);
              }}
            />
          )}
        </Field>
        {offers.length > 0 && (
          <div className="budget-offers" role="group" aria-label="What it was given">
            <p className="muted small">What it was given</p>
            <div className="budget-offer-list">
              {offers.map((offer) => (
                <button
                  key={offer.label}
                  type="button"
                  className="chip"
                  disabled={off}
                  aria-label={`Use ${offer.label}, ${formatMinor(offer.minor, goal.currency, LOCALE)}`}
                  onClick={() => {
                    setText(amountDraft(offer.minor, goal.currency));
                    setProblem(null);
                  }}
                >
                  <span className="chip-name">
                    {offer.label} {formatMinor(offer.minor, goal.currency, LOCALE)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <Actions problem={formError(problem)}>
        <button type="submit" disabled={off}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </Actions>
    </form>
  );
}
