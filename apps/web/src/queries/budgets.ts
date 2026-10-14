import type { BudgetRow, CategoryKind, ChoiceRow, Month } from '@dinora/core/budgets';
import {
  budgetRowIn,
  budgetRowSchema,
  categoryRowSchema,
  choiceRowSchema,
  compareBudgets,
  compareCategories,
  compareChoices,
  compareRules,
  compareTransactions,
  firstDayOf,
  ruleRowSchema,
  transactionRowSchema,
} from '@dinora/core/budgets';
import { parse } from '@dinora/core/parse';
import { z } from 'zod';

import { supabase } from '../supabase/client.ts';
import { defineSynced } from './synced.ts';
import { writeFailed } from './writes.ts';

/**
 * The transactions, read by the app for the first time (BUD-01), and the four tables of hers
 * that sort them. All kept on the device, so the month reads with no signal.
 *
 * About 8,500 transactions in production on 25 Sep: nine pages the first time a device reads
 * them, and after that only what changed, on the `(user_id, updated_at)` index the migration
 * adds. `memo`, `origin` and the bank's ids are left out: nothing on the page reads them, and a
 * column never read cannot be shown by mistake.
 */
export const TRANSACTIONS = defineSynced({
  name: 'transactions',
  columns:
    'id,updated_at,deleted_at,account_id,posted_at,transacted_at,amount_minor,payee,description,source_category,pending',
  schema: transactionRowSchema,
  compare: compareTransactions,
});

export const CATEGORIES = defineSynced({
  name: 'categories',
  columns: 'id,updated_at,deleted_at,name,kind,guesses_from,created_at',
  schema: categoryRowSchema,
  compare: compareCategories,
});

export const CATEGORY_BUDGETS = defineSynced({
  name: 'category_budgets',
  columns: 'id,updated_at,deleted_at,category_id,starts_on,amount_minor,currency',
  schema: budgetRowSchema,
  compare: compareBudgets,
});

export const TRANSACTION_CATEGORIES = defineSynced({
  name: 'transaction_categories',
  columns: 'id,updated_at,deleted_at,transaction_id,category_id',
  schema: choiceRowSchema,
  compare: compareChoices,
});

export const CATEGORY_RULES = defineSynced({
  name: 'category_rules',
  columns: 'id,updated_at,deleted_at,payee,category_id,starts_on,created_at',
  schema: ruleRowSchema,
  compare: compareRules,
});

export type CategoryDetails = {
  readonly name: string;
  readonly kind: CategoryKind;
  readonly guessesFrom: readonly string[];
};

function columns(details: CategoryDetails) {
  return { name: details.name, kind: details.kind, guesses_from: details.guessesFrom };
}

/** Online only (PLAT-02), as every write. */
export async function addCategory(userId: string, details: CategoryDetails): Promise<string> {
  const { data, error, status } = await supabase
    .from('categories')
    .insert({ user_id: userId, ...columns(details) })
    .select('id')
    .single();
  if (error !== null) throw writeFailed('the category was not saved', error, status);
  const made = parse(z.object({ id: z.string() }), data);
  if (!made.ok) throw new Error('the category was saved, and its id could not be read');
  return made.value.id;
}

/** Several at once, for the start the aggregator's categories give: one request, all or none. */
export async function addCategories(
  userId: string,
  list: readonly CategoryDetails[],
): Promise<void> {
  if (list.length === 0) return;
  const { error, status } = await supabase
    .from('categories')
    .insert(list.map((details) => ({ user_id: userId, ...columns(details) })));
  if (error !== null) throw writeFailed('the categories were not saved', error, status);
}

export async function updateCategory(id: string, details: CategoryDetails): Promise<void> {
  const { error, status } = await supabase.from('categories').update(columns(details)).eq('id', id);
  if (error !== null) throw writeFailed('the category was not saved', error, status);
}

/** Removed, not deleted (invariant 2). What it held falls to the next way of filing it. */
export async function removeCategory(id: string): Promise<void> {
  const { error, status } = await supabase
    .from('categories')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error !== null) throw writeFailed('the category was not removed', error, status);
}

/**
 * A category's budget from `month` on; null for none from then. The row that starts in that
 * month is edited when there is one, so changing her mind twice in September leaves one
 * September row, not two; otherwise a new row starts there and every earlier month keeps its
 * own.
 */
export async function setBudget(
  userId: string,
  categoryId: string,
  month: Month,
  amountMinor: number | null,
  currency: string,
  budgets: readonly BudgetRow[],
): Promise<void> {
  const existing = budgetRowIn(categoryId, month, budgets);
  const { error, status } =
    existing === null
      ? await supabase.from('category_budgets').insert({
          user_id: userId,
          category_id: categoryId,
          starts_on: firstDayOf(month),
          amount_minor: amountMinor,
          currency,
        })
      : await supabase
          .from('category_budgets')
          .update({ amount_minor: amountMinor })
          .eq('id', existing.id);
  if (error !== null) throw writeFailed('the budget was not saved', error, status);
}

/**
 * Files one transaction under a category, or takes her choice away (null). A choice is never
 * repointed: the old one is removed and a new one added, as the migration insists.
 */
export async function chooseCategory(
  userId: string,
  transactionId: string,
  categoryId: string | null,
  choices: readonly ChoiceRow[],
): Promise<void> {
  const live = choices.filter((c) => c.transaction_id === transactionId && c.deleted_at === null);
  if (live.some((c) => c.category_id === categoryId)) return;
  if (live.length > 0) {
    const { error, status } = await supabase
      .from('transaction_categories')
      .update({ deleted_at: new Date().toISOString() })
      .in(
        'id',
        live.map((c) => c.id),
      );
    if (error !== null) throw writeFailed('the category was not saved', error, status);
  }
  if (categoryId === null) return;
  const { error, status } = await supabase
    .from('transaction_categories')
    .insert({ user_id: userId, transaction_id: transactionId, category_id: categoryId });
  if (error !== null) throw writeFailed('the category was not saved', error, status);
}

/**
 * Every transaction from `payee` (normalised, `normalisePayee`) filed under a category from
 * `month` on, or, with null, no longer filed by a rule from then. Always a new row: the months
 * an older rule covered keep it.
 */
export async function addRule(
  userId: string,
  payee: string,
  categoryId: string | null,
  month: Month,
): Promise<void> {
  const { error, status } = await supabase.from('category_rules').insert({
    user_id: userId,
    payee,
    category_id: categoryId,
    starts_on: firstDayOf(month),
  });
  if (error !== null) throw writeFailed('the rule was not saved', error, status);
}
