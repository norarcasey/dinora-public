/**
 * Claude Code's SessionStart, SubagentStart and PostToolUse-on-EnterWorktree hook: install when
 * node_modules was not installed from this lockfile.
 *
 * A worktree under .claude/worktrees is a fresh checkout with no node_modules, so a session
 * started in one would otherwise meet its first `pnpm gate` as "command not found". It also
 * catches the main checkout after a pull that moved the lockfile. SubagentStart too, because a
 * subagent given `isolation: "worktree"` gets no SessionStart — measured on Claude Code 2.1.280,
 * 24 Sep 2026: it started in .claude/worktrees/agent-<id> with no node_modules and no hook
 * output. SubagentStart fires for it, with the subagent's worktree as `cwd`.
 *
 * And after EnterWorktree, because a session that moves into a worktree partway through fires
 * neither start event (DIN-1 met `vite: command not found` that way, 3 Oct 2026). Measured on
 * 2.1.289, 4 Oct 2026: PostToolUse on EnterWorktree fires after the switch, with the new
 * worktree as `cwd`.
 *
 * Not the WorktreeCreate hook: that replaces worktree creation wholesale and switches
 * .worktreeinclude off, so the env files would stop being copied. This runs on every session
 * start instead, and when nothing changed it costs one file compare — pnpm keeps a copy of the
 * lockfile it installed from at node_modules/.pnpm/lock.yaml, byte-identical to
 * pnpm-lock.yaml (measured 24 Sep 2026). A fresh worktree installed in 1.1 s from a warm
 * store; an install with nothing to do took 0.36 s, which is why this compares first.
 *
 * What it says lands in the session's (or the subagent's) context, as `additionalContext`, so
 * it says something only when it acted or could not.
 *
 * It runs under `fnm exec --using=.node-version` (.claude/settings.json), so the Node running
 * it is the repository's, and it hands that Node to the session's Bash through
 * CLAUDE_ENV_FILE. Neither the hooks nor an agent's Bash get fnm's cd hook, which only an
 * interactive zsh runs: on bare `node` both were Homebrew's 26, and since engine-strict
 * (DIN-6) pnpm refuses every install and every `pnpm run` there. This run's own worktree
 * started with no node_modules that way (DIN-7, 5 Oct 2026).
 *
 * And it says when the main checkout is behind origin/main, because that checkout's copy of
 * this file and of .claude/settings.json is the one that runs: CLAUDE_PROJECT_DIR names it
 * even in a worktree. Agents push from worktrees with `git push origin HEAD:main` and never
 * pulled it, so a hook fix pushed that way did nothing: the main checkout sat at af4e36a with
 * origin/main at 52c1c2e, and EnterWorktree ran the old hook on Node 26 and failed the install
 * (DIN-9, 7 Oct 2026). Ship it now fast-forwards the main checkout every time; this is for
 * when that step was missed. It reads only local refs (a push from a worktree moves
 * origin/main in the repository every worktree shares), so it costs no network and knows
 * nothing of pushes made from another machine.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Input = { readonly cwd: string; readonly event: string | null };

/**
 * The directory comes from the hook's input, not the environment: CLAUDE_PROJECT_DIR names the
 * main checkout even in a worktree. Run by hand, there is no input and no event.
 */
function readInput(): Input {
  const byHand = { cwd: process.cwd(), event: null };
  if (process.stdin.isTTY) return byHand;
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return byHand;
  }
  if (typeof input !== 'object' || input === null) return byHand;
  const cwd = 'cwd' in input && typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const event =
    'hook_event_name' in input && typeof input.hook_event_name === 'string'
      ? input.hook_event_name
      : null;
  return { cwd, event };
}

const { cwd: dir, event } = readInput();

/** A hook prints one JSON object, so everything to say is said together, at the end. */
const said: string[] = [];

function say(message: string): void {
  said.push(message);
}

function flush(): void {
  if (said.length === 0) return;
  const message = said.join('\n\n');
  if (event === null) console.log(message);
  else {
    const hookSpecificOutput = { hookEventName: event, additionalContext: message };
    console.log(JSON.stringify({ hookSpecificOutput }));
  }
}

function git(cwd: string, args: readonly string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Only a main checkout on `main` that origin/main is strictly ahead of: one on another branch,
 * or with commits of its own, is somebody's work, and a pull is not the answer there.
 */
function checkMainCheckout(): void {
  const main = process.env['CLAUDE_PROJECT_DIR'];
  if (main === undefined || main === '' || !existsSync(main)) return;
  if (git(main, ['symbolic-ref', '--short', 'HEAD']) !== 'main') return;
  const behind = git(main, ['rev-list', '--count', 'HEAD..origin/main']);
  const ahead = git(main, ['rev-list', '--count', 'origin/main..HEAD']);
  if (behind === null || behind === '0' || ahead !== '0') return;
  const hooks = git(main, [
    'diff',
    '--name-only',
    'HEAD',
    'origin/main',
    '--',
    '.claude/settings.json',
    'scripts/session-start.ts',
    '.node-version',
  ]);
  const stale =
    hooks === null || hooks === ''
      ? ''
      : ` The hooks that just ran are older than origin/main's: ${hooks.split('\n').join(', ')} changed since.`;
  say(
    `session-start: the main checkout ${main} is ${behind} commit(s) behind origin/main.${stale} ` +
      `Fast-forward it with \`git -C ${main} pull --ff-only\` (Ship it, step 5) and change nothing else there.`,
  );
}

// Sourced before each of the session's Bash commands; Claude Code sets it for SessionStart.
// A path that holds a quote is not one fnm makes, so it is left alone rather than escaped.
const envFile = process.env['CLAUDE_ENV_FILE'];
const nodeBin = dirname(process.execPath);
if (envFile !== undefined && envFile !== '' && !nodeBin.includes('"')) {
  appendFileSync(envFile, `export PATH="${nodeBin}:$PATH"\n`);
}

checkMainCheckout();

let root: string;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  say(`session-start: ${dir} is not inside a git checkout; dependencies not checked.`);
  flush();
  process.exit(0);
}

const lock = join(root, 'pnpm-lock.yaml');
if (!existsSync(lock)) {
  say(`session-start: no pnpm-lock.yaml in ${root}; run \`pnpm install\` before the gate.`);
  flush();
  process.exit(0);
}
const installedFrom = join(root, 'node_modules', '.pnpm', 'lock.yaml');
if (existsSync(installedFrom) && readFileSync(installedFrom).equals(readFileSync(lock))) {
  flush();
  process.exit(0);
}

const why = existsSync(installedFrom)
  ? 'the lockfile changed since the last install'
  : 'nothing was installed in this checkout';
const started = Date.now();
const result = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
  cwd: root,
  encoding: 'utf8',
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (result.status === 0) {
  say(`session-start: installed dependencies in ${root} (${why}), ${seconds} s.`);
} else {
  const output = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-15).join('\n');
  say(
    `session-start: \`pnpm install --frozen-lockfile\` FAILED in ${root} (${why}). ` +
      `Nothing in this checkout will run until it succeeds:\n${output}`,
  );
}
flush();
