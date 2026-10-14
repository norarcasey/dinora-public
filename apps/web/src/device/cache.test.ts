import { describe, expect, it } from 'vitest';

import type { CacheableTable } from './cache.ts';
import { judgeRecord, restoredAt } from './cache.ts';

const OWNER = '11111111-1111-1111-1111-111111111111';
const STRANGER = '22222222-2222-2222-2222-222222222222';

const things: CacheableTable = {
  name: 'things',
  queryKey: ['synced', 'things'],
  columns: 'id,title,updated_at,deleted_at',
  parseRows: (rows) => rows,
};

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    table: 'things',
    userId: OWNER,
    columns: things.columns,
    fetchedAt: 1_790_000_000_000,
    since: '2026-09-24T09:00:00.000+00:00',
    rows: [{ id: 'a' }],
    ...overrides,
  };
}

describe('judgeRecord', () => {
  it('accepts a record this account wrote with these columns', () => {
    expect(judgeRecord(record(), things, OWNER).kind).toBe('usable');
  });

  it('accepts a record saved before the first read landed', () => {
    expect(judgeRecord(record({ since: null, rows: [] }), things, OWNER).kind).toBe('usable');
  });

  it("says so when the rows are somebody else's, so the store can be emptied", () => {
    expect(judgeRecord(record(), things, STRANGER)).toEqual({ kind: 'not-yours' });
  });

  it('asks whose it is before anything else', () => {
    // A stranger's record with stale columns is still a stranger's: emptied, not skipped.
    expect(judgeRecord(record({ columns: 'id' }), things, STRANGER)).toEqual({ kind: 'not-yours' });
  });

  it('refuses rows read with a different select list', () => {
    // A build that added a column: the held rows lack it, and an incremental read would only
    // ever bring it for rows that changed. Discarded whole; the next read is a full one.
    expect(judgeRecord(record({ columns: `${things.columns},colour` }), things, OWNER)).toEqual({
      kind: 'unusable',
    });
  });

  it('refuses a record filed under another table', () => {
    expect(judgeRecord(record({ table: 'others' }), things, OWNER)).toEqual({ kind: 'unusable' });
  });

  it('refuses a fetchedAt that is not a time', () => {
    for (const fetchedAt of [Number.NaN, Number.POSITIVE_INFINITY, '1790000000000', null]) {
      expect(judgeRecord(record({ fetchedAt }), things, OWNER)).toEqual({ kind: 'unusable' });
    }
  });

  it('refuses a watermark that is neither a string nor null', () => {
    expect(judgeRecord(record({ since: 5 }), things, OWNER)).toEqual({ kind: 'unusable' });
    expect(judgeRecord(record({ since: undefined }), things, OWNER)).toEqual({ kind: 'unusable' });
  });

  it('refuses rows that are not a list, and anything that is not a record', () => {
    expect(judgeRecord(record({ rows: {} }), things, OWNER)).toEqual({ kind: 'unusable' });
    for (const raw of [undefined, null, 'things', {}]) {
      expect(judgeRecord(raw, things, OWNER)).toEqual({ kind: 'unusable' });
    }
  });
});

describe('restoredAt', () => {
  it('is when the server last answered', () => {
    expect(restoredAt(1_000, 9_000)).toBe(1_000);
  });

  it('never claims to be from the future', () => {
    expect(restoredAt(9_000, 1_000)).toBe(1_000);
  });
});
