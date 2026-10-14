/**
 * The public copy of Dinora, made from this private repository (DIN-12).
 *
 *   pnpm public:export ../dinora-public
 *
 * Copies HEAD (committed files only, never the working tree), drops what only this machine's
 * workflow uses, swaps every term in `.env.public-redactions` for its stand-in, refuses on
 * anything that survived, then runs the gate in the copy and commits it there as one root
 * commit. It pushes nothing: making a repository public is Nora's step, by hand.
 *
 * One commit, not this history, because the history is where the personal record lives — the
 * retired RUNWAY.md quoting her for months, and fixtures since replaced — and rewriting 203
 * commits to be sure of every one of them is the error-prone road (decided 13 Oct 2026).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { commentsOnly, parseRedactions, redact, secrets, survivors } from './redact.ts';

const TITLE = 'Public export refused.';

function fail(message: string): never {
  console.error(`\n${TITLE}\n\n${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * This machine's workflow, not the app: the agents' instructions, the tracker's app key and
 * the hooks that install worktrees, with the script those hooks run. Nothing in the build or
 * the gate reads them. CLAUDE.md's invariants are not lost with it: they live in
 * `docs/architecture.md`, which it imports (DIN-18).
 */
const PRIVATE = [
  'CLAUDE.md',
  '.linora-app',
  '.claude',
  '.worktreeinclude',
  'scripts/session-start.ts',
];

const MAP = '.env.public-redactions';

const target = process.argv[2];
if (target === undefined) fail('Say where the copy goes: pnpm public:export <directory>.');

const root = run('git', ['rev-parse', '--show-toplevel'], process.cwd()).trim();
const out = resolve(target);
if (out === root || out.startsWith(`${root}/`)) {
  fail(`${out} is inside this repository. Put the copy beside it, not in it.`);
}
if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} is not empty.`);

const mapPath = join(root, MAP);
if (!existsSync(mapPath)) {
  fail(
    `${MAP} is missing from ${root}.\n\n` +
      'It lists every private term and its stand-in, one `term => stand-in` a line, and is\n' +
      'never committed. In a worktree it is copied from the main checkout by .worktreeinclude.',
  );
}
const parsed = parseRedactions(readFileSync(mapPath, 'utf8'));
if (!parsed.ok) fail(`${MAP} could not be read: ${parsed.reason}.`);
const redactions = parsed.value;

const head = run('git', ['rev-parse', '--short', 'HEAD'], root).trim();
mkdirSync(out, { recursive: true });
// Through a file, not a pipe: the archive is past execFileSync's 1 MB buffer (measured 1.07 MB
// at the first export, 13 Oct 2026), and a buffer that overflows kills git mid-archive.
const archive = join(out, '.head.tar');
run('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD'], root);
run('tar', ['-x', '-f', archive, '-C', out], out);
rmSync(archive);
for (const path of PRIVATE) rmSync(join(out, path), { recursive: true, force: true });

const problems: string[] = [];
const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
for (const entry of files) {
  const path = join(entry.parentPath, entry.name);
  const name = relative(out, path);
  if (/(^|\/)\.env(\.(?!example$)|$)/.test(name)) problems.push(`${name}: an env file`);
  for (const term of survivors(name, redactions)) problems.push(`${name}: "${term}" in its name`);

  const bytes = readFileSync(path);
  // A NUL in the first 8 KB is how git itself decides a file is binary: the icons and fonts.
  if (bytes.subarray(0, 8192).includes(0)) continue;
  const before = bytes.toString('utf8');
  const after = redact(before, redactions);
  if (after !== before) {
    if (name.startsWith('supabase/migrations/')) {
      const verdict = commentsOnly(before, after);
      if (!verdict.ok)
        problems.push(`${name}: a term in its SQL, not a comment (${verdict.reason})`);
    }
    writeFileSync(path, after, { mode: statSync(path).mode });
  }
  for (const term of survivors(after, redactions)) problems.push(`${name}: "${term}" survived`);
  for (const secret of secrets(after)) problems.push(`${name}: ${secret}`);
}

if (problems.length > 0) {
  rmSync(out, { recursive: true, force: true });
  fail(
    `${problems.length} problem(s), and the copy has been removed:\n\n  ${problems.join('\n  ')}\n\n` +
      `A term in another case needs its own line in ${MAP}.`,
  );
}

// The stand-ins change test fixtures, so the copy has to pass the gate on its own before it
// is anything anyone could clone. A red copy is left in place to be read, and not committed.
console.log(`Redacted ${files.length} files from ${head}. Running the gate in the copy…`);
try {
  run('pnpm', ['install', '--frozen-lockfile'], out);
  // A stand-in a few characters longer than its term moves where Prettier wraps a line: four
  // test files at the first export. Formatting the copy is the copy's own rule applied to it.
  run('pnpm', ['format'], out);
  run('pnpm', ['gate'], out);
} catch {
  fail(`The gate failed in ${out}. It is left there uncommitted; read it, fix the map, delete it.`);
}
rmSync(join(out, 'node_modules'), { recursive: true, force: true });
rmSync(join(out, 'coverage'), { recursive: true, force: true });

run('git', ['init', '--quiet', '--initial-branch=main'], out);
run('git', ['add', '--all'], out);
// The machine's commit hook asks every commit for its tracker ticket. This repository has no
// tracker and no history to attribute, so it is the one commit made without asking.
run(
  'git',
  ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', `Dinora\n\nFrom ${head}.`],
  out,
);

console.log(
  `\nExported ${head} to ${out} as one commit, its gate green. Nothing was pushed.\n\n` +
    'To publish it, from that directory:\n\n' +
    '  gh repo create <name> --public --source . --push\n',
);
