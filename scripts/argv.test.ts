import { describe, expect, it } from 'vitest';

import { expandHome, flag } from './argv.ts';

describe('flag', () => {
  it('reads the value after a flag, and nothing for a flag not given', () => {
    expect(flag(['--email', 'a@b.test'], '--email')).toEqual({ ok: true, value: 'a@b.test' });
    expect(flag(['--store'], '--email')).toEqual({ ok: true, value: undefined });
  });

  it('refuses a flag given with nothing after it or with another flag after it', () => {
    expect(flag(['--email'], '--email')).toEqual({ ok: false, reason: '--email takes a value' });
    expect(flag(['--email', '--store'], '--email').ok).toBe(false);
  });

  it('keeps a value with spaces whole', () => {
    expect(flag(['--why', 'closed in 2024'], '--why')).toEqual({
      ok: true,
      value: 'closed in 2024',
    });
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/ and nothing else', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/Downloads', '/h')).toBe('/h/Downloads');
    expect(expandHome('~other/x', '/h')).toBe('~other/x');
    expect(expandHome('/abs/~', '/h')).toBe('/abs/~');
  });
});
