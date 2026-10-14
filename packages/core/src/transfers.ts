import type { TransactionRow } from './budgets.ts';
import { dayOf } from './budgets.ts';

/*
 * Both sides of a transfer (BUD-05). A card payment reaches the rows twice: leaving checking and
 * arriving on the card. Until 26 Sep each side was filed on its own, so one guessed as spending
 * counted the payment on top of the purchases it paid for, and one left uncategorized counted
 * nothing. The pair is found here from the rows alone, and `makeFiler` files the two together.
 */

/**
 * How far apart the two sides may be, in days. A payment leaves checking on one day and posts
 * to the card up to three business days later; five covers that across a weekend. A guess, not
 * measured against production's card payments.
 */
export const PAIR_DAYS = 5;

/** Each paired transaction's id, to the transaction on the other side. */
export type Pairs = ReadonlyMap<string, TransactionRow>;

/**
 * Pairs money out of one of her accounts with the same amount into another, within `PAIR_DAYS`.
 * `currencies` holds every account she has, in any group, so a payment to a loan or a
 * brokerage pairs too, though that side is not on the budget.
 *
 * Only an exact match in one currency pairs: a move from dollars to euros arrives as a different
 * number, and a guessed rate would pair strangers. Each transaction pairs once. Where more than
 * one could match, the closest days go first, then the earlier, then by id, so every device
 * finds the same pairs.
 *
 * A $5 purchase on one card and a $5 refund on another within the week pair as well. Nothing
 * in the rows tells them from a payment, so a pair is shown as one, and her choice undoes it.
 */
export function pairTransfers(
  transactions: readonly TransactionRow[],
  currencies: ReadonlyMap<string, string>,
  today: string,
): Pairs {
  type Side = { readonly transaction: TransactionRow; readonly day: number };
  const groups = new Map<string, { outs: Side[]; ins: Side[] }>();
  for (const transaction of transactions) {
    const currency = currencies.get(transaction.account_id);
    const minor = transaction.amount_minor;
    if (transaction.deleted_at !== null || currency === undefined || minor === 0) continue;
    const key = `${currency}:${Math.abs(minor)}`;
    const group = groups.get(key) ?? { outs: [], ins: [] };
    const side = { transaction, day: Date.parse(`${dayOf(transaction, today)}T00:00:00Z`) };
    (minor < 0 ? group.outs : group.ins).push(side);
    groups.set(key, group);
  }

  const pairs = new Map<string, TransactionRow>();
  for (const { outs, ins } of groups.values()) {
    const candidates: { out: Side; in: Side; apart: number }[] = [];
    for (const out of outs) {
      for (const into of ins) {
        const apart = Math.abs(out.day - into.day) / 86_400_000;
        if (out.transaction.account_id === into.transaction.account_id || apart > PAIR_DAYS) {
          continue;
        }
        candidates.push({ out, in: into, apart });
      }
    }
    candidates.sort(
      (a, b) =>
        a.apart - b.apart ||
        Math.min(a.out.day, a.in.day) - Math.min(b.out.day, b.in.day) ||
        a.out.transaction.id.localeCompare(b.out.transaction.id) ||
        a.in.transaction.id.localeCompare(b.in.transaction.id),
    );
    for (const { out, in: into } of candidates) {
      if (pairs.has(out.transaction.id) || pairs.has(into.transaction.id)) continue;
      pairs.set(out.transaction.id, into.transaction);
      pairs.set(into.transaction.id, out.transaction);
    }
  }
  return pairs;
}
