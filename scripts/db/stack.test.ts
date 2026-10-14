import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MAIN_SLOT,
  WORKTREE_SLOTS,
  chooseSlot,
  orphans,
  overrides,
  portsFor,
  readConfig,
  worktreeProjectId,
} from './stack.ts';

describe('readConfig', () => {
  it("agrees with this repository's own config.toml", () => {
    const toml = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
    const config = readConfig(toml);
    if (typeof config === 'string') throw new Error(config);
    const main = portsFor(config.block, MAIN_SLOT);
    // Each port the file sets is the one the main slot computes, so the arithmetic a worktree
    // uses is the layout config.toml actually has.
    for (const [key, section] of [
      ['api', /^\[api\][^[]*?^port\s*=\s*(\d+)/ms],
      ['db', /^\[db\][^[]*?^port\s*=\s*(\d+)/ms],
      ['shadow', /^\[db\][^[]*?^shadow_port\s*=\s*(\d+)/ms],
      ['pooler', /^\[db\.pooler\][^[]*?^port\s*=\s*(\d+)/ms],
      ['studio', /^\[studio\][^[]*?^port\s*=\s*(\d+)/ms],
      ['smtp', /^\[local_smtp\][^[]*?^port\s*=\s*(\d+)/ms],
      ['analytics', /^\[analytics\][^[]*?^port\s*=\s*(\d+)/ms],
    ] as const) {
      expect([key, Number(section.exec(toml)?.[1])]).toEqual([key, main[key]]);
    }
  });

  it('says what is missing rather than guessing', () => {
    expect(readConfig('[api]\nport = 54621\n')).toContain('project_id');
    expect(readConfig('project_id = "x"\n[db]\nport = 54622\n')).toContain('[api] port');
  });

  it('refuses a layout it would compute wrongly', () => {
    expect(readConfig('project_id = "x"\n[api]\nport = 54631\n')).toContain('x2x');
  });
});

describe('portsFor', () => {
  it('puts a worktree in another tens digit of the same block', () => {
    expect(portsFor(546, 3)).toEqual({
      shadow: 54630,
      api: 54631,
      db: 54632,
      studio: 54633,
      smtp: 54634,
      analytics: 54637,
      pooler: 54639,
    });
  });

  it('never leaves the block, whichever slot', () => {
    for (const slot of [MAIN_SLOT, ...WORKTREE_SLOTS]) {
      for (const port of Object.values(portsFor(546, slot))) {
        expect(Math.floor(port / 100)).toBe(546);
      }
    }
  });
});

describe('chooseSlot', () => {
  it('takes the first slot nobody holds and nothing is listening on', () => {
    expect(chooseSlot(new Set(), new Set())).toBe(3);
    expect(chooseSlot(new Set([3]), new Set([4]))).toBe(5);
  });

  it('never gives out the main checkout slot', () => {
    expect(WORKTREE_SLOTS).not.toContain(MAIN_SLOT);
  });

  it('says there is none rather than sharing one', () => {
    expect(chooseSlot(new Set(WORKTREE_SLOTS), new Set())).toBeNull();
  });
});

describe('worktreeProjectId', () => {
  it("is the app's id and the worktree's directory, in Docker's alphabet", () => {
    expect(worktreeProjectId('dinora', 'SKL-06 budgets')).toBe('dinora-wt-skl-06-budgets');
    expect(worktreeProjectId('dinora', '--')).toBe('dinora-wt-unnamed');
  });
});

describe('overrides', () => {
  it('names every port the CLI would otherwise take from config.toml', () => {
    const env = overrides('dinora-wt-a', portsFor(546, 3));
    expect(env.SUPABASE_PROJECT_ID).toBe('dinora-wt-a');
    expect(Object.keys(env)).toHaveLength(8);
  });
});

describe('orphans', () => {
  const containers = [
    'supabase_db_dinora',
    'supabase_db_dinora-wt-a',
    'supabase_db_dinora-wt-gone',
    'supabase_kong_dinora-wt-gone',
    'supabase_db_other-wt-gone',
    '',
  ];

  it("lists this app's worktree stacks with no worktree behind them", () => {
    expect(orphans(containers, 'dinora', new Set(['dinora-wt-a']))).toEqual(['dinora-wt-gone']);
  });

  it("never the main checkout's stack, and never another app's", () => {
    expect(orphans(containers, 'dinora', new Set())).toEqual(['dinora-wt-a', 'dinora-wt-gone']);
  });
});
