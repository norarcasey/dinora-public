import { z } from 'zod';

/**
 * Balance history (ACCT-03): one row per account per day, as `bank_store` keeps it.
 *
 * `read` is what the bank said; `rebuilt` is a day before an account's first reading, walked
 * back from it through the settled transactions, and has to be shown as a guess; `monarch`
 * is Monarch's balance for a day before Dinora's own history of the account (ACCT-05). The
 * rules that write them are in the migration (20260924200000_balance_snapshots.sql), beside
 * the transactions they read, so a night stores and rebuilds in one transaction.
 */

const timestamp = z.iso.datetime({ offset: true });

export const snapshotRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  account_id: z.string(),
  on_date: z.iso.date(),
  kind: z.enum(['read', 'rebuilt', 'monarch', 'statement']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  // `z.int()` is a safe integer: past 2^53 a bigint column would arrive already rounded.
  balance_minor: z.int(),
  as_of: timestamp,
});

export type SnapshotRow = z.output<typeof snapshotRowSchema>;

/** Oldest day first, the order a line is drawn in; by account within a day. */
export function compareSnapshots(a: SnapshotRow, b: SnapshotRow): number {
  return (
    a.on_date.localeCompare(b.on_date) ||
    a.account_id.localeCompare(b.account_id) ||
    a.id.localeCompare(b.id)
  );
}
