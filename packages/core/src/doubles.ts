import { z } from 'zod';

import type { AccountRow } from './balances.ts';
import { compareAccounts } from './balances.ts';
import type { GoalAccountRow, GoalRow } from './goals.ts';
import { compareGoals } from './goals.ts';

/**
 * An account counted twice (BANK-15): once as the history Monarch had of it, once as the bank
 * that now reads it. `monarch:import` links the two only when its mapping was drawn after the
 * bank reported the account, so every account a bank starts reading later arrives beside its
 * Monarch copy and both count in net worth. By 26 Sep 2026 that had happened four times —
 * Northwind, Lakeside Bank, Gemini, the Meridian 401(k) — and each was found by Nora, by eye.
 *
 * Found from the accounts as they are, not from the pull that added one: a double that
 * already exists is found the same way as tomorrow's, and the check needs no state of its own.
 *
 * Never acted on by itself. Two cards at one bank can end in the same four digits, and a wrong
 * merge moves years of history onto the wrong account, which is harder to undo than a double
 * count she can see. Putting the two together is hers: a tap on the flag, confirmed (BANK-17),
 * or `pnpm monarch:import --link` on the Mac.
 */
export type Double = { readonly monarch: AccountRow; readonly bank: AccountRow };

/**
 * The last four digits of the last run of four or more in a name, or null. Wherever the
 * number is: Monarch writes `… - **0717 (...0717)`, the Bridge wrote the same 401(k) as
 * `… - 550717` and a card as `Savings (0391)`, and Plaid's names carry the mask the nightly
 * adds (`plaidRows`). A run of three — the `401` in `401(K)` — is not an account number.
 */
export function accountDigits(name: string): string | null {
  const runs = name.match(/\d{4,}/g);
  return runs?.at(-1)?.slice(-4) ?? null;
}

/**
 * Every live Monarch account beside every live bank account that ends in the same four digits
 * in the same currency. One Monarch account that matches two bank accounts is two pairs: which
 * one it is, if either, is hers to say.
 */
export function doubledAccounts(accounts: readonly AccountRow[]): Double[] {
  const live = accounts.filter((a) => a.deleted_at === null);
  const banks = live.filter((a) => a.source !== 'monarch');
  const doubles: Double[] = [];
  for (const monarch of live.filter((a) => a.source === 'monarch').sort(compareAccounts)) {
    const digits = accountDigits(monarch.name);
    if (digits === null) continue;
    for (const bank of banks
      .filter((b) => b.currency === monarch.currency && accountDigits(b.name) === digits)
      .sort(compareAccounts)) {
      doubles.push({ monarch, bank });
    }
  }
  return doubles;
}

/* ─── putting a pair together from the app (BANK-17) ─────────────────────────────────── */

/** What the page asks `/api/monarch/join`: Dinora's ids for the two, as the flag has them. */
export const joinRequestSchema = z.object({ monarch: z.guid(), bank: z.guid() });

/** What `monarch_join` moved and retired: counts, never an amount or a payee (invariant 4). */
export const joinedSchema = z.object({
  days_moved: z.int(),
  days_left: z.int(),
  transactions_moved: z.int(),
  transactions_left: z.int(),
});

export const joinAnswerSchema = z.discriminatedUnion('kind', [
  joinedSchema.extend({ kind: z.literal('joined') }),
  z.object({ kind: z.literal('refused'), reason: z.string() }),
]);

export type JoinAnswer = z.output<typeof joinAnswerSchema>;

/**
 * Why `monarch_join` refused, in her words, from the code it raises. Each is a refusal of
 * `linkPair`'s, found by the database now instead of by the import: the flag was drawn from
 * what this device last read, and by the tap the two may already be one.
 */
const REFUSALS = new Map([
  ['not_monarch', 'the first account is not Monarch’s history'],
  ['already_joined', 'these two are already put together'],
  ['not_bank', 'the second account is not one a bank reads'],
  ['bank_deleted', 'the bank’s account is removed'],
  ['currency', 'the two are in different currencies'],
  [
    'no_history',
    'the bank has not given this account a day of history yet: wait for the next night',
  ],
  ['not_history', 'the mapping does not have this Monarch account as history only'],
  ['taken', 'another Monarch account is already put together with this bank account'],
]);

/**
 * The live goals that count an account, in the order she made them. Asked of the Monarch copy
 * before it is retired: the join cannot move a goal's accounts, which are hers and not the
 * server's to change, so a goal counting the copy would quietly stop counting it.
 */
export function goalsCounting(
  accountId: string,
  goals: readonly GoalRow[],
  links: readonly GoalAccountRow[],
): string[] {
  const counting = new Set(
    links
      .filter((link) => link.deleted_at === null && link.account_id === accountId)
      .map((link) => link.goal_id),
  );
  return goals
    .filter((goal) => goal.deleted_at === null && counting.has(goal.id))
    .sort(compareGoals)
    .map((goal) => goal.name);
}

/** The refusal in a database error's message, or null for an error that is not one. */
export function joinRefusal(message: string): string | null {
  const code = /\bmonarch_join: (\w+)/.exec(message)?.[1];
  return code === undefined ? null : (REFUSALS.get(code) ?? null);
}

/**
 * What puts a pair together: the import, told which Monarch account is which bank account.
 * It moves Monarch's history onto the bank's account and marks the Monarch copy deleted
 * (`monarch_store`, invariant 2). Account ids, never names: a name holds quotes and spaces a
 * shell reads, and an id is what the import looks both accounts up by.
 */
export function linkCommand({ monarch, bank }: Double): string {
  return `pnpm monarch:import --production --link ${monarch.id} --to ${bank.id}`;
}
