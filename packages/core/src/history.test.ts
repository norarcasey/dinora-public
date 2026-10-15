import { describe, expect, it } from 'vitest';

import { compareSnapshots, snapshotRowSchema } from './history.ts';

const row = {
  id: 'r1',
  updated_at: '2026-09-25T09:00:01.123456+00:00',
  deleted_at: null,
  account_id: 'a1',
  on_date: '2026-09-25',
  kind: 'read',
  currency: 'USD',
  balance_minor: -123_45,
  as_of: '2026-09-25T08:59:00+00:00',
};

describe('snapshotRowSchema', () => {
  it('reads a row as PostgREST sends it', () => {
    expect(snapshotRowSchema.parse(row)).toEqual(row);
  });

  it("reads Monarch's days as their own kind", () => {
    expect(snapshotRowSchema.parse({ ...row, kind: 'monarch' }).kind).toBe('monarch');
  });

  it('refuses a kind it does not know, a float and an unsafe integer', () => {
    expect(snapshotRowSchema.safeParse({ ...row, kind: 'guessed' }).success).toBe(false);
    expect(snapshotRowSchema.safeParse({ ...row, balance_minor: 1.5 }).success).toBe(false);
    expect(snapshotRowSchema.safeParse({ ...row, balance_minor: 2 ** 53 }).success).toBe(false);
  });
});

describe('compareSnapshots', () => {
  it('orders by day, then account, then id', () => {
    const parsed = snapshotRowSchema.parse(row);
    const rows = [
      { ...parsed, id: 'r4', on_date: '2026-09-26' },
      { ...parsed, id: 'r3', account_id: 'a2' },
      { ...parsed, id: 'r2' },
      { ...parsed, id: 'r1', on_date: '2026-09-24' },
    ];
    expect(rows.sort(compareSnapshots).map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});
