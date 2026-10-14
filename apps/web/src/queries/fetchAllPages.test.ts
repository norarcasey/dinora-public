import { describe, expect, it } from 'vitest';

import { fetchAllPages } from './fetchAllPages.ts';

function table(size: number) {
  const all = Array.from({ length: size }, (_, i) => ({ id: i }));
  const asked: [number, number][] = [];
  const page = (from: number, to: number) => {
    asked.push([from, to]);
    return Promise.resolve({ data: all.slice(from, to + 1), error: null });
  };
  return { page, asked };
}

describe('fetchAllPages', () => {
  it('reads a short table in one request', async () => {
    const { page, asked } = table(3);
    expect(await fetchAllPages(page)).toHaveLength(3);
    expect(asked).toEqual([[0, 999]]);
  });

  it('keeps asking past the cap PostgREST applies silently', async () => {
    const { page, asked } = table(2_500);
    expect(await fetchAllPages(page)).toHaveLength(2_500);
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('asks once more when the table is an exact multiple of a page', async () => {
    const { page, asked } = table(1_000);
    expect(await fetchAllPages(page)).toHaveLength(1_000);
    expect(asked).toHaveLength(2);
  });

  it('treats no data as an empty page', async () => {
    expect(await fetchAllPages(() => Promise.resolve({ data: null, error: null }))).toEqual([]);
  });

  it('throws on an error rather than returning what it had', async () => {
    const failing = () => Promise.resolve({ data: null, error: { code: '42501' } });
    await expect(fetchAllPages(failing)).rejects.toThrow('42501');
  });

  it('throws rather than stop quietly at its own ceiling', async () => {
    const endless = () =>
      Promise.resolve({ data: Array.from({ length: 1000 }, () => ({})), error: null });
    await expect(fetchAllPages(endless)).rejects.toThrow('100000');
  });
});
