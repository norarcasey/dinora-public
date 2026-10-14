import { z } from 'zod';

import type { Total } from './balances.ts';
import type { Amount, Filer, Month, TransactionRow } from './budgets.ts';
import { dayOf, firstDayOf, lastDayOf, monthOf } from './budgets.ts';
import type { GoalAccountRow, GoalRow } from './goals.ts';
import { compareGoals } from './goals.ts';
import type { Conversion, RateRow } from './rates.ts';
import { sumIn } from './rates.ts';
import type { Pairs } from './transfers.ts';

/**
 * Goals in the monthly budget (GOAL-04): what each goal was given in a month, against what she
 * planned to give it.
 *
 * Nora, 26 Sep, on Monarch: *"Where I want to set how much money I put towards or subtract from
 * a goal isn't always a strictly one to one transaction"*, and of a card payoff that spans
 * several cards, *"it is really important not to double dip on this in the budget or the
 * goal"*. So nothing ties a transaction to a goal. Each goal has accounts of its own
 * (GOAL-01), and what it was given in a month is the money moved into them from her other
 * accounts:
 *
 *   * a transaction in one of the goal's accounts, filed as a transfer — by her, a rule, the
 *     pair it makes (BUD-05) or Monarch's guess — counts, money in as given and money out as
 *     taken back;
 *   * one whose other side is also in the goal's accounts is a move inside the goal, and
 *     counts nothing;
 *   * anything else in those accounts is not a contribution: a new charge on a card, a refund,
 *     interest, a market's move. They move the balance, which the progress bar still reads
 *     whole, as GOAL-01 decided; they were not money she gave it.
 *
 * Counted once: a $2,000 card payment is a transfer on the budget, since the purchases it paid
 * were counted as they were made, and $2,000 on the goal. The budget never counts a transfer,
 * and the goal counts only the side that landed in its accounts.
 *
 * The first idea, the balance's movement over the month, was wrong for cards: it nets the
 * payments against the new charges, so a month she paid $2,000 and spent $1,800 would read as
 * $200 given.
 */

const day = z.iso.date();

/** A goal's plan from a month on (`goal_plans`). In the goal's currency, which cannot change. */
export const goalPlanRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  goal_id: z.string(),
  starts_on: day,
  // `z.int()` is a safe integer: past 2^53 a bigint column would arrive already rounded.
  amount_minor: z.int().nonnegative().nullable(),
});

export type GoalPlanRow = z.output<typeof goalPlanRowSchema>;

export function compareGoalPlans(a: GoalPlanRow, b: GoalPlanRow): number {
  return a.goal_id.localeCompare(b.goal_id) || a.starts_on.localeCompare(b.starts_on);
}

export type Plan = {
  readonly row: GoalPlanRow;
  readonly amountMinor: number;
};

/**
 * A goal's plan for a month: the newest row starting on or before it. None when there is no
 * row, or when the newest says none from then on — as a category's budget (`budgetFor`).
 */
export function planFor(goalId: string, month: Month, plans: readonly GoalPlanRow[]): Plan | null {
  const first = firstDayOf(month);
  let newest: GoalPlanRow | null = null;
  for (const row of plans) {
    if (row.deleted_at !== null || row.goal_id !== goalId || row.starts_on > first) continue;
    if (newest === null || row.starts_on > newest.starts_on) newest = row;
  }
  return newest === null || newest.amount_minor === null
    ? null
    : { row: newest, amountMinor: newest.amount_minor };
}

/** The live row that starts in exactly this month, which a change from this month edits. */
export function planRowIn(
  goalId: string,
  month: Month,
  plans: readonly GoalPlanRow[],
): GoalPlanRow | null {
  const first = firstDayOf(month);
  return (
    plans.find(
      (row) => row.deleted_at === null && row.goal_id === goalId && row.starts_on === first,
    ) ?? null
  );
}

/* ─── what a goal was given ─────────────────────────────────────────────────────────────── */

export type Contribution = {
  readonly transaction: TransactionRow;
  /** Its account's. */
  readonly currency: string;
  readonly day: string;
  /**
   * The other side, outside the goal (BUD-05). Null when none was found: she filed it as a
   * transfer, and the other side is in no account Dinora reads, or too far apart to pair.
   */
  readonly partner: TransactionRow | null;
};

/**
 * The month's contributions to the goal whose live accounts are `goalAccounts`, newest first.
 * `currencies` holds every account she has, so a transaction in a goal's loan or brokerage
 * account is read though the budget does not count that account.
 */
export function contributionsIn(
  month: Month,
  goalAccounts: ReadonlySet<string>,
  transactions: readonly TransactionRow[],
  currencies: ReadonlyMap<string, string>,
  file: Filer,
  pairs: Pairs,
  today: string,
): Contribution[] {
  const found: Contribution[] = [];
  for (const transaction of transactions) {
    const currency = currencies.get(transaction.account_id);
    if (
      transaction.deleted_at !== null ||
      transaction.amount_minor === 0 ||
      currency === undefined ||
      !goalAccounts.has(transaction.account_id)
    ) {
      continue;
    }
    const on = dayOf(transaction, today);
    if (monthOf(on) !== month) continue;
    const filed = file(transaction);
    if (filed.kind === 'none' || filed.category.kind !== 'transfer') continue;
    const partner = pairs.get(transaction.id) ?? null;
    if (partner !== null && goalAccounts.has(partner.account_id)) continue;
    found.push({ transaction, currency, day: on, partner });
  }
  return found.sort(
    (a, b) => b.day.localeCompare(a.day) || a.transaction.id.localeCompare(b.transaction.id),
  );
}

export type GoalMonth = {
  readonly goal: GoalRow;
  readonly month: Month;
  readonly contributions: readonly Contribution[];
  /** Money in less money out, in the goal's currency: below zero when more was taken back. */
  readonly given: Amount;
  readonly plan: Plan | null;
  /** The day whose rates converted anything not in the goal's currency, as `summarise`. */
  readonly ratesOn: string;
  /** Each currency converted, with the stored rate it used (invariant 3). */
  readonly conversions: readonly Conversion[];
};

/**
 * What one goal was given in a month, against its plan. Summed per currency and converted at
 * one rate per currency, the month's last day's or today's while it runs, as the month's
 * spending is, so a past month reads the same next year (invariant 3).
 */
export function goalMonth(
  goal: GoalRow,
  month: Month,
  links: readonly GoalAccountRow[],
  transactions: readonly TransactionRow[],
  currencies: ReadonlyMap<string, string>,
  file: Filer,
  pairs: Pairs,
  plans: readonly GoalPlanRow[],
  rates: readonly RateRow[],
  today: string,
): GoalMonth {
  const accounts = new Set(
    links
      .filter((link) => link.goal_id === goal.id && link.deleted_at === null)
      .map((link) => link.account_id),
  );
  const contributions = contributionsIn(
    month,
    accounts,
    transactions,
    currencies,
    file,
    pairs,
    today,
  );
  const totals = new Map<string, bigint>();
  for (const c of contributions) {
    totals.set(c.currency, (totals.get(c.currency) ?? 0n) + BigInt(c.transaction.amount_minor));
  }
  const last = lastDayOf(month);
  const ratesOn = today < last ? today : last;
  const list: Total[] = [...totals].map(([currency, minor]) => ({ currency, minor, accounts: 0 }));
  const sum = sumIn(list, rates, goal.currency, ratesOn);
  return {
    goal,
    month,
    contributions,
    given:
      sum.kind === 'summed'
        ? { kind: 'summed', minor: sum.minor }
        : { kind: 'unrated', missing: sum.missing },
    plan: planFor(goal.id, month, plans),
    ratesOn,
    conversions: sum.kind === 'summed' ? sum.conversions : [],
  };
}

/** Every live goal's month, in the order she made them. */
export function goalsIn(
  month: Month,
  goals: readonly GoalRow[],
  links: readonly GoalAccountRow[],
  transactions: readonly TransactionRow[],
  currencies: ReadonlyMap<string, string>,
  file: Filer,
  pairs: Pairs,
  plans: readonly GoalPlanRow[],
  rates: readonly RateRow[],
  today: string,
): GoalMonth[] {
  return goals
    .filter((goal) => goal.deleted_at === null)
    .sort(compareGoals)
    .map((goal) =>
      goalMonth(goal, month, links, transactions, currencies, file, pairs, plans, rates, today),
    );
}

/** Tenths of a percent of a plan given, from 0; above 1000 once past it. Null for no plan. */
export function givenShare(givenMinor: bigint, planMinor: number): number | null {
  if (planMinor <= 0) return null;
  return givenMinor <= 0n ? 0 : Number((givenMinor * 1000n) / BigInt(planMinor));
}
