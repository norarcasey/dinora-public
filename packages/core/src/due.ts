import type { AccountRow } from './balances.ts';
import type { GoalRow, Progress } from './goals.ts';
import type { TermRow } from './terms.ts';
import { cardTerms, daysBetween, PROMO_WARNING_DAYS } from './terms.ts';

/**
 * What is due (ACCT-15): one short list of the dates Dinora already holds, soonest first, so
 * none of them waits on her opening the right detail page. From the design audit of 26 Sep
 * 2026, which found each date kept only on its own page.
 *
 * Two kinds today: a card's promo APR ending (ACCT-10) and a goal's target date (GOAL-01).
 * The third the audit named, Enable Banking's consent to renew about every 180 days, is not
 * here because no consent is held yet: it arrives with BANK-03, as a third member of `Due`.
 */

/**
 * How far ahead the list looks. Two months is time to move a promo balance before the card's
 * own rate is back, or to change a goal's date rather than miss it. Reasoned, not measured.
 */
export const DUE_AHEAD_DAYS = 60;

/**
 * How long a date stays after it passes: long enough to be seen on a phone opened once a
 * week or two, short enough that the list does not become a record of what went by. Also
 * reasoned, not measured.
 */
export const DUE_BEHIND_DAYS = 14;

export type Due =
  | {
      readonly kind: 'promo';
      readonly on: string;
      /** Negative once it has passed. */
      readonly daysLeft: number;
      /** Inside `PROMO_WARNING_DAYS`, as the card's own page colours it. */
      readonly soon: boolean;
      readonly account: AccountRow;
      readonly rateBp: number;
      /** The purchase APR in force the day the promo ends, if she entered one. */
      readonly thenBp: number | null;
    }
  | {
      readonly kind: 'goal';
      readonly on: string;
      readonly daysLeft: number;
      readonly goal: GoalRow;
      /** Null while the pace cannot be told. */
      readonly onPace: boolean | null;
    };

function inWindow(daysLeft: number): boolean {
  return daysLeft <= DUE_AHEAD_DAYS && daysLeft >= -DUE_BEHIND_DAYS;
}

/**
 * Soonest first; on one day a promo before a goal, since its end is the bank's date and a
 * goal's is her own.
 *
 * A goal already reached has nothing due. A promo is its account's promo in force today, so
 * one she replaced with a newer is not listed twice; a promo entered to start later is not
 * due until it has started.
 */
export function dueItems(
  accounts: readonly AccountRow[],
  terms: readonly TermRow[],
  goals: readonly { readonly goal: GoalRow; readonly progress: Progress }[],
  today: string,
): Due[] {
  const due: Due[] = [];
  for (const account of accounts) {
    if (account.deleted_at !== null) continue;
    const promo = cardTerms(terms, account.id, today).figures.promo_apr.current;
    if (promo === null || promo.kind !== 'promo_apr') continue;
    const daysLeft = daysBetween(today, promo.ends_on);
    if (!inWindow(daysLeft)) continue;
    // The rate the day it ends, not today's: a rise she entered ahead is the one that bites.
    const then = cardTerms(terms, account.id, promo.ends_on).figures.purchase_apr.current;
    due.push({
      kind: 'promo',
      on: promo.ends_on,
      daysLeft,
      soon: daysLeft <= PROMO_WARNING_DAYS,
      account,
      rateBp: promo.rate_bp,
      thenBp: then !== null && then.kind === 'purchase_apr' ? then.rate_bp : null,
    });
  }
  for (const { goal, progress } of goals) {
    if (goal.deleted_at !== null || goal.target_on === null) continue;
    if ((progress.kind === 'save' || progress.kind === 'payoff') && progress.reached) continue;
    const daysLeft = daysBetween(today, goal.target_on);
    if (!inWindow(daysLeft)) continue;
    due.push({
      kind: 'goal',
      on: goal.target_on,
      daysLeft,
      goal,
      onPace:
        progress.kind === 'save' || progress.kind === 'payoff'
          ? (progress.deadline?.onPace ?? null)
          : null,
    });
  }
  const rank = (item: Due) => (item.kind === 'promo' ? 0 : 1);
  return due.toSorted((a, b) => a.on.localeCompare(b.on) || rank(a) - rank(b));
}
