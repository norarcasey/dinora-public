import type { Month } from '@dinora/core/budgets';
import { firstDayOf } from '@dinora/core/budgets';
import type { GoalPlanRow } from '@dinora/core/contributions';
import { compareGoalPlans, goalPlanRowSchema, planRowIn } from '@dinora/core/contributions';
import type { GoalAccountRow, GoalKind } from '@dinora/core/goals';
import {
  compareGoalAccounts,
  compareGoals,
  goalAccountRowSchema,
  goalRowSchema,
} from '@dinora/core/goals';
import { parse } from '@dinora/core/parse';
import { z } from 'zod';

import { supabase } from '../supabase/client.ts';
import { defineSynced } from './synced.ts';
import { writeFailed } from './writes.ts';

/**
 * Her goals and the accounts each counts (GOAL-01), kept on the device like the accounts, so
 * how far along each is shows with no signal. A handful of rows: nothing here is a balance.
 */
export const GOALS = defineSynced({
  name: 'goals',
  columns:
    'id,updated_at,deleted_at,name,kind,currency,target_minor,starts_on,target_on,created_at',
  schema: goalRowSchema,
  compare: compareGoals,
});

export const GOAL_ACCOUNTS = defineSynced({
  name: 'goal_accounts',
  columns: 'id,updated_at,deleted_at,goal_id,account_id',
  schema: goalAccountRowSchema,
  compare: compareGoalAccounts,
});

/** What she plans to give each goal a month (GOAL-04): a few rows a goal, a year at most. */
export const GOAL_PLANS = defineSynced({
  name: 'goal_plans',
  columns: 'id,updated_at,deleted_at,goal_id,starts_on,amount_minor',
  schema: goalPlanRowSchema,
  compare: compareGoalPlans,
});

/** What she can change about a goal. Its kind and currency are fixed once it is made. */
export type GoalDetails = {
  readonly name: string;
  /** A saving's; null for a payoff, whose target is zero. */
  readonly targetMinor: number | null;
  readonly startsOn: string;
  readonly targetOn: string | null;
};

function columns(details: GoalDetails) {
  return {
    name: details.name,
    target_minor: details.targetMinor,
    starts_on: details.startsOn,
    target_on: details.targetOn,
  };
}

/**
 * Adds a goal with its accounts, and answers its id. Two requests, as an asset and its first
 * value are: a goal whose accounts failed is still a goal, shown as counting nothing, and its
 * page offers them again. Online only (PLAT-02).
 */
export async function addGoal(
  userId: string,
  kind: GoalKind,
  currency: string,
  details: GoalDetails,
  accountIds: readonly string[],
): Promise<string> {
  const { data, error, status } = await supabase
    .from('goals')
    .insert({ user_id: userId, kind, currency, ...columns(details) })
    .select('id')
    .single();
  if (error !== null) throw writeFailed('the goal was not saved', error, status);
  const made = parse(z.object({ id: z.string() }), data);
  if (!made.ok) throw new Error('the goal was saved, and its id could not be read');
  await setAccounts(userId, made.value.id, [], accountIds);
  return made.value.id;
}

export async function updateGoal(id: string, details: GoalDetails): Promise<void> {
  const { error, status } = await supabase.from('goals').update(columns(details)).eq('id', id);
  if (error !== null) throw writeFailed('the goal was not saved', error, status);
}

/**
 * Makes the goal count `wanted`. A link is never repointed: one taken out is removed and one
 * put in is added (the migration's rule), so what a goal counted stays as history.
 */
export async function setAccounts(
  userId: string,
  goalId: string,
  links: readonly GoalAccountRow[],
  wanted: readonly string[],
): Promise<void> {
  const live = links.filter((link) => link.goal_id === goalId && link.deleted_at === null);
  const out = live.filter((link) => !wanted.includes(link.account_id)).map((link) => link.id);
  const kept = new Set(live.map((link) => link.account_id));
  const added = wanted.filter((accountId) => !kept.has(accountId));
  if (out.length > 0) {
    const { error, status } = await supabase
      .from('goal_accounts')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', out);
    if (error !== null) throw writeFailed('the accounts were not saved', error, status);
  }
  if (added.length > 0) {
    const { error, status } = await supabase
      .from('goal_accounts')
      .insert(
        added.map((accountId) => ({ user_id: userId, goal_id: goalId, account_id: accountId })),
      );
    if (error !== null) throw writeFailed('the accounts were not saved', error, status);
  }
}

/**
 * A goal's plan from `month` on, in its own currency; null for none from then. As a category's
 * budget (`setBudget`): the row that starts in that month is edited when there is one, and
 * otherwise a new row starts there, so every earlier month keeps its own.
 */
export async function setPlan(
  userId: string,
  goalId: string,
  month: Month,
  amountMinor: number | null,
  plans: readonly GoalPlanRow[],
): Promise<void> {
  const existing = planRowIn(goalId, month, plans);
  const { error, status } =
    existing === null
      ? await supabase.from('goal_plans').insert({
          user_id: userId,
          goal_id: goalId,
          starts_on: firstDayOf(month),
          amount_minor: amountMinor,
        })
      : await supabase
          .from('goal_plans')
          .update({ amount_minor: amountMinor })
          .eq('id', existing.id);
  if (error !== null) throw writeFailed('the plan was not saved', error, status);
}

/** Given up, reached and done with, or made by mistake. Removed, not deleted (invariant 2). */
export async function removeGoal(id: string): Promise<void> {
  const { error, status } = await supabase
    .from('goals')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error !== null) throw writeFailed('the goal was not removed', error, status);
}
