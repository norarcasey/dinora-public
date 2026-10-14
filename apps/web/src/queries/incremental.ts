import type { Syncable } from '@dinora/core/sync';
import { askFrom, mergeById, watermark } from '@dinora/core/sync';

import { fetchAllPages } from './fetchAllPages.ts';

/**
 * A table's rows and the watermark they were read to, held together.
 *
 * Together because they must never be separated: a watermark without its rows would ask only
 * for what changed since, and everything older would never arrive. When the query is
 * garbage-collected both go, and the next read is a full one — the correct failure.
 */
export type Cached<Row> = { readonly rows: readonly Row[]; readonly since: string | null };

type Page = { readonly data: readonly unknown[] | null; readonly error: { code: string } | null };

export type IncrementalRead<Row extends Syncable> = {
  /** `since` null wants every live row; a timestamp wants everything since, deleted included. */
  readonly page: (from: number, to: number, since: string | null) => PromiseLike<Page>;
  /** Parses a page off the wire. Throws on a row that does not fit, failing the read. */
  readonly parse: (rows: readonly unknown[]) => Row[];
  readonly compare?: ((a: Row, b: Row) => number) | undefined;
};

/** Everything the first time, and only what changed after that. See `core/sync.ts`. */
export async function fetchIncrementally<Row extends Syncable>(
  previous: Cached<Row> | undefined,
  read: IncrementalRead<Row>,
): Promise<Cached<Row>> {
  const since = previous?.since ?? null;
  const rows = read.parse(await fetchAllPages((from, to) => read.page(from, to, askFrom(since))));

  /*
    Nothing changed, and the object says so by being the same one — which is what lets the
    device cache skip rewriting the table to disk to record that nothing happened (at four
    thousand rows, 2.5 MB per refetch, measured in Nora Bene). Only for a read that asked for
    changes: an empty answer to a first read means the account has no live rows, and whatever
    is held must go.
  */
  if (since !== null && rows.length === 0 && previous !== undefined) return previous;

  const base = since === null ? [] : (previous?.rows ?? []);
  return { rows: mergeById(base, rows, read.compare), since: watermark(since, rows) };
}
