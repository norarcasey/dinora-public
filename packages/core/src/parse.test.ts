import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parse } from './parse.ts';

const item = z.object({ id: z.string(), count: z.number().int() });

describe('parse', () => {
  it('returns the value typed by the schema', () => {
    expect(parse(item, { id: 'a', count: 2 })).toEqual({
      ok: true,
      value: { id: 'a', count: 2 },
    });
  });

  it('names the field that failed rather than returning nothing', () => {
    const result = parse(item, { id: 'a', count: 2.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatch(/^count: /);
  });

  it('says when the input itself is the wrong shape', () => {
    const result = parse(item, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatch(/^\(root\): /);
  });
});
