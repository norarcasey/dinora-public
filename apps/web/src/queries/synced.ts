import type { Syncable } from '@dinora/core/sync';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import type { CacheableTable } from '../device/cache.ts';
import { getRestoredSnapshot, subscribeRestored } from '../device/cache.ts';
import { supabase } from '../supabase/client.ts';
import type { Cached } from './incremental.ts';
import { fetchIncrementally } from './incremental.ts';

/**
 * A table the app reads, keeps on the device and can show with no signal.
 *
 * Defined once per table and listed in `tables.ts`. The rows are kept as PostgREST sends them
 * — snake_case, parsed by `schema` — so what is on disk and what is on the wire are one shape.
 * The table needs `id`, `updated_at` and `deleted_at`, which `owned_table.sql` gives it, and an
 * index on `(user_id, updated_at)` for the changed-since read.
 */
export type SyncedTable<Row extends Syncable> = CacheableTable & {
  readonly schema: z.ZodType<Row>;
  readonly compare: ((a: Row, b: Row) => number) | undefined;
};

export function defineSynced<Row extends Syncable>(spec: {
  readonly name: string;
  /** The select list, spelled out: it is also the cache's fingerprint. `*` would hide a change. */
  readonly columns: string;
  readonly schema: z.ZodType<Row>;
  readonly compare?: (a: Row, b: Row) => number;
}): SyncedTable<Row> {
  const rows = z.array(spec.schema);
  return {
    name: spec.name,
    queryKey: ['synced', spec.name],
    columns: spec.columns,
    schema: spec.schema,
    compare: spec.compare,
    parseRows: (raw) => {
      const parsed = rows.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
  };
}

/** One page of a table: every live row the first time, every changed row after. */
function readPage(table: CacheableTable, from: number, to: number, since: string | null) {
  // Ordered by id, a total order, so paging can neither repeat nor skip a row.
  const query = supabase
    .from(table.name)
    .select(table.columns)
    .order('id', { ascending: true })
    .range(from, to);
  // A changed read keeps deleted rows: a removal IS an update, and it has to arrive for the
  // row to leave.
  return since === null ? query.is('deleted_at', null) : query.gte('updated_at', since);
}

export type SyncedRows<Row> =
  /** Nothing held yet, from the disk or the server. Not the same as no rows. */
  | { readonly status: 'waiting' }
  /** Nothing held, and the read failed. */
  | { readonly status: 'failed' }
  | {
      readonly status: 'held';
      readonly rows: readonly Row[];
      /** When the server last answered for these rows, epoch ms — restored rows keep theirs. */
      readonly asOf: number;
      readonly refreshing: boolean;
      /** The last read failed; `rows` are what was held before it. */
      readonly stale: boolean;
    };

/** Whether the disk has been consulted. Queries wait on it; renders never do. */
export function useCacheRestored(): boolean {
  return useSyncExternalStore(subscribeRestored, getRestoredSnapshot, getRestoredSnapshot);
}

export function useSynced<Row extends Syncable>(table: SyncedTable<Row>): SyncedRows<Row> {
  const client = useQueryClient();
  const restored = useCacheRestored();

  const query = useQuery({
    queryKey: table.queryKey,
    queryFn: () =>
      fetchIncrementally(client.getQueryData<Cached<Row>>(table.queryKey), {
        page: (from, to, since) => readPage(table, from, to, since),
        parse: (rows) => z.array(table.schema).parse(rows),
        compare: table.compare,
      }),
    // Not before the disk has answered: a read that started first would find nothing held and
    // ask for every row the account owns, on the one open where that costs most.
    enabled: restored,
    staleTime: 10_000,
  });

  if (query.data === undefined) {
    return query.isError ? { status: 'failed' } : { status: 'waiting' };
  }
  return {
    status: 'held',
    rows: query.data.rows,
    asOf: query.dataUpdatedAt,
    refreshing: query.isFetching,
    stale: query.isError,
  };
}
