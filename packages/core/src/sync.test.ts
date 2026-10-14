import { describe, expect, it } from 'vitest';

import { askFrom, mergeById, watermark } from './sync.ts';

type Row = {
  readonly id: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly title: string;
};

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  updated_at: '2026-09-24T10:00:00.000+00:00',
  deleted_at: null,
  title: id,
  ...over,
});

const byTitle = (a: Row, b: Row): number => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

describe('watermark', () => {
  it('takes the newest it has been shown', () => {
    expect(
      watermark(null, [
        { updated_at: '2026-09-24T10:00:00+00:00' },
        { updated_at: '2026-09-24T12:00:00+00:00' },
        { updated_at: '2026-09-24T11:00:00+00:00' },
      ]),
    ).toBe('2026-09-24T12:00:00+00:00');
  });

  it('never goes backwards', () => {
    expect(
      watermark('2026-09-24T12:00:00+00:00', [{ updated_at: '2026-01-01T00:00:00+00:00' }]),
    ).toBe('2026-09-24T12:00:00+00:00');
  });

  it('holds when nothing changed, and stays null when nothing was ever read', () => {
    expect(watermark('2026-09-24T12:00:00+00:00', [])).toBe('2026-09-24T12:00:00+00:00');
    expect(watermark(null, [])).toBeNull();
  });
});

describe('askFrom', () => {
  it('asks for everything when nothing is held', () => {
    expect(askFrom(null)).toBeNull();
  });

  it('asks from two seconds before the watermark', () => {
    expect(askFrom('2026-09-24T12:00:00.000Z')).toBe('2026-09-24T11:59:58.000Z');
  });

  it('widens rather than narrows when microseconds are lost', () => {
    const asked = askFrom('2026-09-24T12:00:00.123456+00:00');
    expect(asked).toBe('2026-09-24T11:59:58.123Z');
  });

  it('asks from an unparseable watermark as given', () => {
    expect(askFrom('not a time')).toBe('not a time');
  });
});

describe('mergeById', () => {
  const held = [row('a'), row('b')];

  it('replaces what changed and keeps the rest', () => {
    const merged = mergeById(held, [row('a', { title: 'edited' })]);
    expect(merged.map((r) => r.title)).toEqual(['edited', 'b']);
  });

  it('adds what it has not seen', () => {
    expect(mergeById(held, [row('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a row that comes back deleted', () => {
    const merged = mergeById(held, [row('a', { deleted_at: '2026-09-24T13:00:00+00:00' })]);
    expect(merged.map((r) => r.id)).toEqual(['b']);
  });

  it('ignores a deleted row it never held', () => {
    const merged = mergeById(held, [row('z', { deleted_at: '2026-09-24T13:00:00+00:00' })]);
    expect(merged).toEqual(held);
  });

  it('restores the promised order', () => {
    const merged = mergeById([row('a', { title: 'm' })], [row('b', { title: 'c' })], byTitle);
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('returns a copy when nothing came back', () => {
    const merged = mergeById(held, []);
    expect(merged).toEqual(held);
    expect(merged).not.toBe(held);
  });
});
