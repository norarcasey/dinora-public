/**
 * Reading what changed rather than everything.
 *
 * A table is read whole once; after that the client remembers the newest `updated_at` it has
 * seen — the watermark — and asks only for rows written since. A later read then costs what
 * changed, not what the account owns. This module is that arithmetic, kept pure. Lifted from
 * Nora Bene (`OPS-6` there), where the full re-read had grown with every row anyone owned.
 *
 * Two properties of the schema make it safe, and the `supabase` layer's table pattern gives
 * both:
 *
 *   * **Nothing hard-deletes.** A removal is an update carrying `deleted_at`, so a row leaves
 *     the client by the same path it arrived on. A changed read must therefore NOT filter
 *     deleted rows out. A table whose rows can vanish would need a full read to notice.
 *   * **`updated_at` is written by a trigger**, never by a client, so no clock but the
 *     database's decides what is newer.
 */

/** Keys are the wire's: rows are kept as PostgREST sends them. */
export type Syncable = {
  readonly id: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
};

/**
 * The newest `updated_at` seen so far.
 *
 * Compared as strings, deliberately: PostgREST sends every timestamptz in one ISO 8601 form,
 * where lexical order is chronological. Kept beside the rows rather than derived from them,
 * because the rows held have the deleted ones taken out — and a deletion is exactly the
 * change whose timestamp must not be forgotten.
 */
export function watermark(
  previous: string | null,
  rows: readonly { readonly updated_at: string }[],
): string | null {
  let newest = previous;
  for (const row of rows) {
    if (newest === null || row.updated_at > newest) newest = row.updated_at;
  }
  return newest;
}

/**
 * How far before the watermark to ask from.
 *
 * `now()` in Postgres is the transaction's start, not its commit, so a row can become
 * visible carrying a timestamp older than one already read, and a watermark taken in between
 * would step over it for good. Two seconds closes that for any transaction shorter than two
 * seconds, at the price of a few rows already held, which the merge by id discards.
 */
const OVERLAP_MS = 2_000;

/** The timestamp to ask from: earlier than the watermark, never later. */
export function askFrom(held: string | null): string | null {
  if (held === null) return null;
  const parsed = Date.parse(held);
  // Unparseable: ask from it as given. Asking twice is cheap; not asking loses a row.
  if (Number.isNaN(parsed)) return held;
  // Microseconds are lost to Date here, which only ever widens the question.
  return new Date(parsed - OVERLAP_MS).toISOString();
}

/**
 * Folds a page of changes into what is held: incoming rows win by id, and a row that arrives
 * deleted leaves. `compare` restores the order consumers were promised — a merge returns rows
 * in arrival order, which would quietly reshuffle a list.
 */
export function mergeById<T extends Syncable>(
  previous: readonly T[],
  incoming: readonly T[],
  compare?: (a: T, b: T) => number,
): T[] {
  if (incoming.length === 0) return [...previous];

  const byId = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) {
    if (row.deleted_at !== null) byId.delete(row.id);
    else byId.set(row.id, row);
  }

  const merged = [...byId.values()];
  return compare === undefined ? merged : merged.sort(compare);
}
