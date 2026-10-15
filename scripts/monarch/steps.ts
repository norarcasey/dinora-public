/**
 * The decisions in `monarch:import` (`cli.ts`) that a regression would cost, apart from it so a
 * test can import them without running an import (DIN-25). The command writes to production's
 * `monarch_store` and `monarch_decisions`: a mis-read flag or a mis-read mapping there is the
 * expensive failure, so these are what it is tested on.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Decision, Mapping, MappingCopy, Target } from '../../packages/core/src/monarch.ts';
import {
  decisionOf,
  parseMapping,
  readTarget,
  sameTarget,
} from '../../packages/core/src/monarch.ts';
import type { Read } from '../argv.ts';
import { expandHome, flag } from '../argv.ts';
import { decideSql, readDecisionsWritten, readRefusal } from './sql.ts';

/** A new decision `--set` asks for. A link's target is only the id until Dinora names it. */
export type SetArgs = { readonly name: string; readonly target: Target; readonly why: string };

export type Args = {
  readonly production: boolean;
  readonly show: boolean;
  readonly dir: string;
  readonly mappingFile: string;
  /** The local user; production has exactly one and is never asked for it by email. */
  readonly email: string;
  readonly link: { readonly from: string; readonly to: string } | null;
  readonly set: SetArgs | null;
};

/**
 * Every flag, read and checked before anything connects to a database: a `--set` that would be
 * refused for its `--as` or its `--why` is refused before production is asked who its user is.
 */
export function readArgs(argv: readonly string[], home: string): Read<Args> {
  const values = new Map<string, string | undefined>();
  for (const name of [
    '--link',
    '--to',
    '--dir',
    '--mapping',
    '--email',
    '--set',
    '--as',
    '--why',
  ]) {
    const read = flag(argv, name);
    if (!read.ok) return read;
    values.set(name, read.value);
  }
  const get = (name: string) => values.get(name);

  const from = get('--link');
  const to = get('--to');
  if ((from === undefined) !== (to === undefined)) {
    return {
      ok: false,
      reason: '--link takes the Monarch account and --to the bank account; give both or neither.',
    };
  }

  const dir = expandHome(get('--dir') ?? join(home, 'Downloads'), home);
  const mappingFile = expandHome(get('--mapping') ?? join(dir, 'monarch-accounts.json'), home);

  let set: SetArgs | null = null;
  const name = get('--set');
  if (name !== undefined) {
    if (from !== undefined) {
      return { ok: false, reason: '--set writes a decision and --link imports: run them apart.' };
    }
    const target = readTarget(get('--as') ?? '');
    if (target === null) {
      return {
        ok: false,
        reason:
          '--as takes history, skip, asset:home, asset:vehicle, asset:valuables or link:<id>.',
      };
    }
    const why = (get('--why') ?? '').trim();
    if (why === '')
      return { ok: false, reason: '--set takes --why: a decision says why it was made.' };
    set = { name, target, why };
  }

  return {
    ok: true,
    value: {
      production: argv.includes('--production'),
      show: argv.includes('--show'),
      dir,
      mappingFile,
      email: get('--email') ?? 'one@example.test',
      link: from !== undefined && to !== undefined ? { from, to } : null,
      set,
    },
  };
}

/** Monarch names each download by the time it was made, so the newest is the last by name. */
export function newest(files: readonly string[], prefix: string): string | undefined {
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .sort()
    .at(-1);
}

export function readMappingFile(file: string): Read<Mapping> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: `${file} could not be read.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${file} is not JSON.` };
  }
  const parsed = parseMapping(raw);
  if (!parsed.ok) return { ok: false, reason: `${file}: ${parsed.issues.join('; ')}` };
  return { ok: true, value: parsed.value };
}

/**
 * The copies kept before each hand edit, then the file itself: always last, a moment after the
 * newest copy if one was touched after it, since the file is the one Nora confirmed.
 */
export function lastWord(older: readonly MappingCopy[], now: MappingCopy): MappingCopy[] {
  const newestCopy = Math.max(0, ...older.map((c) => Date.parse(c.decided_at)));
  const at = Math.max(Date.parse(now.decided_at), newestCopy + 1);
  return [...older, { ...now, decided_at: new Date(at).toISOString() }];
}

export type Query = (sql: string) => string;

/** The database's reason for a refused query, from what the refused command printed. */
export function refusalOf(error: unknown): string {
  const printed = (stream: unknown) => (typeof stream === 'string' ? stream : '');
  const output =
    error instanceof Error && 'stdout' in error && 'stderr' in error
      ? `${printed(error.stdout)}\n${printed(error.stderr)}`
      : '';
  return readRefusal(output) ?? 'it printed no reason';
}

/** Keeps `decisions` in Dinora, all or none, and answers how many it wrote. */
export function decide(query: Query, userId: string, decisions: readonly Decision[]): Read<number> {
  if (decisions.length === 0) return { ok: true, value: 0 };
  let output: string;
  try {
    output = query(decideSql(userId, decisions));
  } catch (error) {
    return {
      ok: false,
      reason: `the mapping was refused: ${refusalOf(error)}. Nothing of it was written.`,
    };
  }
  const written = readDecisionsWritten(output);
  if (!written.ok) return { ok: false, reason: "the mapping's answer could not be read." };
  return { ok: true, value: written.value };
}

/**
 * The decision `--set` writes, or null when the account already goes there. A link is named
 * from Dinora's own account, so the mapping says which card it is and not only its id; the
 * accounts are read only for a link.
 */
export function settle(
  set: SetArgs,
  mapping: Mapping,
  accounts: () => readonly { source_id: string; institution: string; name: string }[],
  now: string,
): Read<Decision | null> {
  let target = set.target;
  if (typeof target === 'object' && 'link' in target) {
    const link = target.link;
    const bank = accounts().find((a) => a.source_id === link);
    if (bank === undefined) return { ok: false, reason: `no bank account in Dinora is ${link}.` };
    target = { link, is: `${bank.institution} · ${bank.name}` };
  }
  if (sameTarget(mapping.accounts[set.name], target)) return { ok: true, value: null };
  return { ok: true, value: decisionOf(set.name, target, set.why, now) };
}

/**
 * Production is written from the main checkout, after the branch has merged: a worktree's
 * migrations may not be the ones production has, and `monarch_store` must be.
 */
export function isWorktree(cwd: string): boolean {
  const git = (arg: string) =>
    execFileSync('git', ['rev-parse', '--path-format=absolute', arg], {
      cwd,
      encoding: 'utf8',
    }).trim();
  return git('--git-dir') !== git('--git-common-dir');
}
