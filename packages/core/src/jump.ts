import { fold } from './activity.ts';
import type { AccountRow } from './balances.ts';
import type { AssetRow } from './assets.ts';
import type { Month, TransactionRow } from './budgets.ts';
import { dayOf, describeMonth, monthOf, payeeName, payeeOf, shiftMonth } from './budgets.ts';
import type { GoalRow } from './goals.ts';

/**
 * ⌘K (UI-10): one box that goes straight to any account, payee, goal, thing she owns or month,
 * by name. Activity's search (ACCT-14) finds transactions; this finds places, each of which
 * already has a page.
 *
 * Built once when the box opens, then matched on every keystroke. A few hundred payees at most
 * besides a handful of everything else, so each keystroke compares folded text and nothing more.
 */

export const JUMP_KINDS = ['account', 'goal', 'asset', 'payee', 'month'] as const;

export type JumpKind = (typeof JUMP_KINDS)[number];

export type Jump = {
  readonly kind: JumpKind;
  /** What its page is opened by: an account's, goal's or asset's id, a payee's key, a month. */
  readonly id: string;
  readonly label: string;
  /** A line under the label saying what it is. */
  readonly detail: string;
  /** Folded once, here, rather than on every keystroke. */
  readonly text: string;
};

export type JumpSources = {
  readonly accounts: readonly Pick<AccountRow, 'id' | 'name' | 'institution' | 'deleted_at'>[];
  readonly goals: readonly Pick<GoalRow, 'id' | 'name' | 'deleted_at'>[];
  readonly assets: readonly Pick<AssetRow, 'id' | 'name' | 'deleted_at'>[];
  readonly transactions: readonly TransactionRow[];
  readonly today: string;
  readonly locale: string | undefined;
};

/**
 * Every place, in the order a tie is broken in: accounts, goals and things she owns first, since
 * there are few and each is named on purpose; payees by how often she pays them, so `amaz` lands
 * on the one she means rather than one charge from 2024; months newest first.
 */
export function jumpTargets(sources: JumpSources): Jump[] {
  const { today, locale } = sources;
  const targets: Jump[] = [];
  const add = (kind: JumpKind, id: string, label: string, detail: string, also = '') => {
    targets.push({ kind, id, label, detail, text: fold(`${label} ${also}`) });
  };

  for (const a of sources.accounts) {
    if (a.deleted_at !== null) continue;
    const name = a.name || 'Unnamed account';
    add('account', a.id, name, a.institution === '' ? 'Account' : a.institution, a.institution);
  }
  for (const g of sources.goals) {
    if (g.deleted_at === null) add('goal', g.id, g.name, 'Goal');
  }
  for (const a of sources.assets) {
    if (a.deleted_at === null) add('asset', a.id, a.name, 'Something you own');
  }

  // Newest first by the day it happened, so a payee is shown by the name the bank uses now.
  const payees = new Map<string, { name: string; newest: string; count: number }>();
  let oldest: string | null = null;
  for (const t of sources.transactions) {
    if (t.deleted_at !== null) continue;
    const day = dayOf(t, today);
    if (oldest === null || day < oldest) oldest = day;
    const key = payeeOf(t);
    if (key === '') continue;
    const seen = payees.get(key);
    if (seen === undefined) payees.set(key, { name: payeeName(t), newest: day, count: 1 });
    else {
      seen.count += 1;
      if (day > seen.newest) {
        seen.newest = day;
        seen.name = payeeName(t);
      }
    }
  }
  [...payees]
    .sort(
      ([ka, a], [kb, b]) =>
        b.count - a.count || b.newest.localeCompare(a.newest) || ka.localeCompare(kb),
    )
    .forEach(([key, p]) => {
      add('payee', key, p.name, p.count === 1 ? 'Payee, once' : `Payee, ${p.count} times`);
    });

  // Every month a budget can be read for: from the first transaction to this one.
  const current = monthOf(today);
  const first: Month = oldest === null ? current : monthOf(oldest);
  for (let month = current; month >= first; month = shiftMonth(month, -1)) {
    add('month', month, describeMonth(month, locale), 'Budget', month);
  }
  return targets;
}

/**
 * Every word found somewhere in the target, as Activity's search does. Ranked by how the label
 * begins: the whole of what was typed starting the label first, then every word starting a word
 * of it, then anything found. `vis` puts *Visa* before *Advisor*; `sep 25` finds September 2025.
 */
export function findJumps(query: string, targets: readonly Jump[], limit: number): Jump[] {
  const typed = fold(query);
  if (typed === '') return [];
  const words = typed.split(' ');
  const ranked: { readonly target: Jump; readonly rank: number; readonly order: number }[] = [];
  targets.forEach((target, order) => {
    if (!words.every((word) => target.text.includes(word))) return;
    const rank = target.text.startsWith(typed)
      ? 0
      : words.every((word) => target.text.startsWith(word) || target.text.includes(` ${word}`))
        ? 1
        : 2;
    ranked.push({ target, rank, order });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((r) => r.target);
}
