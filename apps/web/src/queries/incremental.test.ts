import { describe, expect, it } from 'vitest';

import type { Cached, IncrementalRead } from './incremental.ts';
import { fetchIncrementally } from './incremental.ts';

type Row = { id: string; updated_at: string; deleted_at: string | null };

const row = (id: string, updated_at: string, deleted_at: string | null = null): Row => ({
  id,
  updated_at,
  deleted_at,
});

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && 'id' in value && 'updated_at' in value;
}

/** A server that answers from a list, and records what it was asked. */
function server(answer: Row[]) {
  const asked: (string | null)[] = [];
  const read: IncrementalRead<Row> = {
    page: (_from, _to, since) => {
      asked.push(since);
      return Promise.resolve({ data: answer, error: null });
    },
    parse: (rows) => rows.filter(isRow),
  };
  return { read, asked };
}

describe('fetchIncrementally', () => {
  it('reads everything the first time and remembers the newest timestamp', async () => {
    const { read, asked } = server([
      row('a', '2026-09-24T10:00:00.000Z'),
      row('b', '2026-09-24T11:00:00.000Z'),
    ]);
    const cached = await fetchIncrementally(undefined, read);
    expect(asked).toEqual([null]);
    expect(cached.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(cached.since).toBe('2026-09-24T11:00:00.000Z');
  });

  it('asks only from just before the watermark afterwards, and merges', async () => {
    const held: Cached<Row> = {
      rows: [row('a', '2026-09-24T10:00:00.000Z')],
      since: '2026-09-24T10:00:00.000Z',
    };
    const { read, asked } = server([row('b', '2026-09-24T12:00:00.000Z')]);
    const cached = await fetchIncrementally(held, read);
    expect(asked).toEqual(['2026-09-24T09:59:58.000Z']);
    expect(cached.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(cached.since).toBe('2026-09-24T12:00:00.000Z');
  });

  it('lets a row removed elsewhere leave', async () => {
    const held: Cached<Row> = {
      rows: [row('a', '2026-09-24T10:00:00.000Z')],
      since: '2026-09-24T10:00:00.000Z',
    };
    const { read } = server([row('a', '2026-09-24T12:00:00.000Z', '2026-09-24T12:00:00.000Z')]);
    const cached = await fetchIncrementally(held, read);
    expect(cached.rows).toEqual([]);
    // The deletion's timestamp is kept, though its row is gone.
    expect(cached.since).toBe('2026-09-24T12:00:00.000Z');
  });

  it('hands back the same object when nothing changed', async () => {
    const held: Cached<Row> = {
      rows: [row('a', '2026-09-24T10:00:00.000Z')],
      since: '2026-09-24T10:00:00.000Z',
    };
    const { read } = server([]);
    expect(await fetchIncrementally(held, read)).toBe(held);
  });

  it('takes an empty first read as the truth, emptying what was held', async () => {
    const held: Cached<Row> = { rows: [row('a', '2026-09-24T10:00:00.000Z')], since: null };
    const { read } = server([]);
    const cached = await fetchIncrementally(held, read);
    expect(cached).toEqual({ rows: [], since: null });
  });
});
