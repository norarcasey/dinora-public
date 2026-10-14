import type { QueryClient } from '@tanstack/react-query';
import { hashKey } from '@tanstack/react-query';
import type { DBSchema } from 'idb';
import { z } from 'zod';

import type { Cached } from '../queries/incremental.ts';
import { opener } from './idb.ts';

/**
 * The rows this device already had, kept across a restart, for one account only.
 *
 * TanStack's cache is memory, so a reopened app holds nothing until the server answers — and
 * offline it never does. This writes each synced table's rows and watermark to IndexedDB as
 * they change, and puts them back before the first query runs. Lifted from Nora Bene
 * (`OFF-2` and `SEC-2` there). Three rules make it safe:
 *
 * **Rows and watermark are one record**, written whole, so a crash cannot separate them — a
 * watermark restored without its rows would never ask for the older ones again.
 *
 * **A restored cache is an incremental read that survived a restart**, so it is marked stale
 * at once and reconciled from its watermark as soon as there is a network. Deleted rows leave
 * by the same path they do in a session (`core/sync.ts`).
 *
 * **A cache belongs to one account.** The record names its owner and is refused for anybody
 * else, and any change of account — sign-out included — empties the store and the in-memory
 * cache with it. The last person's rows staying readable on a shared device is the failure
 * this is written against. The session itself is auth-js's to clear, and it does on sign-out.
 *
 * Not durability: nothing here is anything the server has not got. Losing it costs one full read.
 */

/**
 * What a synced table has to tell the cache. Row-free on purpose, so tables of different row
 * types can sit in one list; `queries/synced.ts` builds one of these per table.
 */
export type CacheableTable = {
  readonly name: string;
  readonly queryKey: readonly ['synced', string];
  /** The select list, and the fingerprint: a record read with other columns is discarded. */
  readonly columns: string;
  /** Rows off the disk, parsed with the table's schema; null if any no longer fits. */
  readonly parseRows: (rows: readonly unknown[]) => readonly unknown[] | null;
};

type CacheRecord = {
  readonly table: string;
  readonly userId: string;
  readonly columns: string;
  /** When the server last answered for these rows, epoch ms. What the app shows as "as of". */
  readonly fetchedAt: number;
  readonly since: string | null;
  readonly rows: readonly unknown[];
};

interface CacheSchema extends DBSchema {
  cache: { key: string; value: CacheRecord };
}

const getDb = opener<CacheSchema>('dinora-cache', 1, (db) => {
  // One record per table, so a save overwrites rather than accumulates.
  if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'table' });
});

/**
 * The envelope, checked at the boundary: the declared store type is a claim about what was
 * written, not evidence about what came back. Rows are only checked for being an array here;
 * the table's own schema parses them in `restore`.
 */
const recordSchema = z.object({
  table: z.string(),
  userId: z.string(),
  columns: z.string(),
  // A fetchedAt that is not a finite number is not a time at all.
  fetchedAt: z.number().finite(),
  since: z.string().nullable(),
  rows: z.array(z.unknown()),
});

export type Judged =
  | { readonly kind: 'usable'; readonly record: z.infer<typeof recordSchema> }
  /** Another account's rows: refused, and the whole store is emptied. */
  | { readonly kind: 'not-yours' }
  /** Absent, malformed, or read with other columns: ignored, and the next read is full. */
  | { readonly kind: 'unusable' };

/**
 * Whether a record read off disk may go back into the query cache. Pure, and the whole of the
 * policy: this decides whether somebody sees their rows, a blank screen or somebody else's.
 */
export function judgeRecord(raw: unknown, table: CacheableTable, userId: string): Judged {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'unusable' };
  // Whose it is first: nothing else matters if it is not yours.
  if (parsed.data.userId !== userId) return { kind: 'not-yours' };
  if (parsed.data.table !== table.name || parsed.data.columns !== table.columns) {
    return { kind: 'unusable' };
  }
  return { kind: 'usable', record: parsed.data };
}

/** A clock that went backwards must not make restored rows claim to be from the future. */
export function restoredAt(fetchedAt: number, now: number): number {
  return Math.min(fetchedAt, now);
}

/* ─── restoring ─────────────────────────────────────────────────────────────────────────── */

let restored = false;
const listeners = new Set<() => void>();

function markRestored(): void {
  if (restored) return;
  restored = true;
  for (const listener of [...listeners]) listener();
}

export function subscribeRestored(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the disk has been consulted. False only for the first moments of a cold open. */
export function getRestoredSnapshot(): boolean {
  return restored;
}

/**
 * How long to wait for IndexedDB before reading from the server instead. Queries are held
 * back until the disk answers, so a cold open does not fire a full read past rows it was about
 * to be handed; Safari's IndexedDB can wedge, and that hold needs a way out. Three seconds is
 * far longer than a real read and far shorter than giving up on the app (Nora Bene's number).
 */
const RESTORE_TIMEOUT_MS = 3_000;

/**
 * Puts the last known rows back, then lets the queries run. Called before React mounts, with
 * the account `rememberedUser` read synchronously, so the disk read overlaps the first render.
 */
export function restoreCache(
  client: QueryClient,
  userId: string | null,
  tables: readonly CacheableTable[],
): void {
  owner = userId;
  // Nobody remembered: nothing here could be theirs.
  if (userId === null || tables.length === 0) {
    markRestored();
    return;
  }
  const timer = setTimeout(markRestored, RESTORE_TIMEOUT_MS);
  readInto(client, userId, tables)
    .catch(() => {
      // No cache this session (private mode, a wedged store): the server fills it instead.
    })
    .finally(() => {
      clearTimeout(timer);
      markRestored();
    });
}

async function readInto(
  client: QueryClient,
  userId: string,
  tables: readonly CacheableTable[],
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  for (const table of tables) {
    const judged = judgeRecord(await db.get('cache', table.name), table, userId);
    /*
      Somebody else's rows, with this account remembered: a session replaced without a
      sign-out (another account signed in on a device that was offline, or storage restored
      from elsewhere). Refusing them is not enough — they would sit on this account's device
      until its first successful read overwrote them — so the store goes now. Measured: before
      this, a second account offline was shown nothing but the first one's rows stayed on disk.
    */
    if (judged.kind === 'not-yours') {
      await db.clear('cache');
      return;
    }
    // `restored` again: the timeout may have fired while the disk was thinking, and a late
    // answer must never land on rows the server has since supplied.
    if (judged.kind === 'unusable' || restored) continue;
    const { record } = judged;
    const rows = table.parseRows(record.rows);
    if (rows === null) continue;

    const cached: Cached<unknown> = { rows, since: record.since };
    client.setQueryData(table.queryKey, cached, {
      updatedAt: restoredAt(record.fetchedAt, now),
    });
    // What was just read is not written straight back.
    written.set(table.name, client.getQueryData(table.queryKey));
    // Owed a reconciliation whatever its age: no server has been asked this session. Said
    // directly rather than by arranging a timestamp old enough to beat `staleTime`.
    await client.invalidateQueries({ queryKey: table.queryKey, exact: true, refetchType: 'none' });
  }
}

/* ─── saving ────────────────────────────────────────────────────────────────────────────── */

/**
 * How long to sit on a change before writing it. Several tables settling after one refetch
 * become one pass; an app closed a second later loses only a slightly older watermark.
 */
const SAVE_THROTTLE_MS = 1_000;

let owner: string | null = null;
let dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** What was last written per table, by identity: an unchanged refetch writes nothing. */
let written = new Map<string, unknown>();

function isCached(value: unknown): value is Cached<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rows' in value &&
    Array.isArray(value.rows) &&
    'since' in value &&
    (value.since === null || typeof value.since === 'string')
  );
}

async function flush(client: QueryClient, tables: readonly CacheableTable[]): Promise<void> {
  const names = dirty;
  dirty = new Set();
  const userId = owner;
  if (userId === null) return;
  try {
    const db = await getDb();
    for (const table of tables) {
      if (!names.has(table.name)) continue;
      const held: unknown = client.getQueryData(table.queryKey);
      if (!isCached(held) || written.get(table.name) === held) continue;
      const fetchedAt = client.getQueryState(table.queryKey)?.dataUpdatedAt ?? Date.now();
      const record: CacheRecord = {
        table: table.name,
        userId,
        columns: table.columns,
        fetchedAt,
        since: held.since,
        rows: held.rows,
      };
      await db.put('cache', record);
      written.set(table.name, held);
    }
  } catch {
    // Quota, a wedged store. The screen is still right; only the next cold open is poorer.
  }
}

/**
 * Writes the synced tables down as they change.
 *
 * **A table's first fill is written at once**, the rest on a one-second throttle. Measured in
 * Chromium on 24 Sep 2026: rows that arrived 350 ms before a reload were not on disk after it,
 * so the next cold open with no signal showed nothing at all. The first fill is the write whose
 * loss costs everything; losing a later one costs a slightly older copy, which reconciles.
 *
 * And when the app is hidden, which is the last chance on a phone: iOS freezes a backgrounded
 * app and may kill it without running a pending timer. Not on `pagehide` — Nora Bene flushes
 * there too, and the same measurement showed an IndexedDB write started in `pagehide` does
 * not survive the reload that fired it. A listener that reads as protection and never lands
 * is worse than none.
 */
export function watchCache(client: QueryClient, tables: readonly CacheableTable[]): () => void {
  // By hash: TanStack types a query's key as `any`, and its hash is the string it matches on.
  const byHash = new Map(tables.map((table) => [hashKey(table.queryKey), table.name]));

  const flushNow = (): void => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    void flush(client, tables);
  };

  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.state.status !== 'success') return;
    const name = byHash.get(event.query.queryHash);
    if (name === undefined) return;
    dirty.add(name);
    if (!written.has(name)) {
      flushNow();
      return;
    }
    saveTimer ??= setTimeout(() => {
      saveTimer = undefined;
      void flush(client, tables);
    }, SAVE_THROTTLE_MS);
  });

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flushNow();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/* ─── whose it is ───────────────────────────────────────────────────────────────────────── */

/**
 * Hands the store to an account, emptying it if it held anybody else's — or anybody's, on
 * sign-out.
 *
 * Never called for `INITIAL_SESSION`: that event reports `null` when a refresh could not
 * reach the server, with the error dropped, and acting on it would wipe the cache on exactly
 * the cold offline open it exists for. A sign-out is a decision and arrives as its own event.
 */
export async function ownCache(client: QueryClient, userId: string | null): Promise<void> {
  if (userId !== null && userId === owner) return;
  owner = userId;
  dirty = new Set();
  written = new Map();
  clearTimeout(saveTimer);
  saveTimer = undefined;
  // The in-memory copy goes too, or the next person to sign in sees the last one's rows.
  client.clear();
  try {
    await (await getDb()).clear('cache');
  } catch {
    // Nothing to empty, or nothing that will let us. `usable` refusing another owner's record
    // is the second lock on the same door.
  }
}

/** Test helper: module state back to a cold open. */
export function resetCacheForTests(): void {
  restored = false;
  listeners.clear();
  owner = null;
  dirty = new Set();
  written = new Map();
  clearTimeout(saveTimer);
  saveTimer = undefined;
}
