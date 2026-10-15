/**
 * Where an export lands, and how it gets there (DIN-17). `export.ts` redacts and gates a
 * snapshot; this decides whether the directory it was pointed at is a new copy or the public
 * checkout, and commits the snapshot into the checkout as one child commit.
 *
 * The first export (DIN-12) made a fresh repository with one root commit. Once
 * `norarcasey/dinora-public` existed (14 Oct 2026), a second root commit shared no history
 * with it and could only be pushed by force. So every release after the first is one commit
 * on top of the last, its tree the new snapshot: history only moves forward and nothing is
 * force-pushed.
 *
 * The danger is the other direction. The private repository is a git checkout too, with all
 * of its history, and an update aimed at it by mistake would commit a redacted tree onto that
 * history — one push from public. So a checkout is taken only when its root commit is an
 * export's and none of its root commits are this repository's.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Parsed } from './redact.ts';

/** The subject of every commit an export makes, the root included. */
export const SUBJECT = 'Dinora';

export type Target =
  { readonly kind: 'fresh' } | { readonly kind: 'update'; readonly head: string };

function git(args: readonly string[], cwd: string, input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

function lines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/**
 * A directory that does not exist or is empty is a new copy. One that is the top of a clean
 * git checkout whose history began with an export is the public checkout. Anything else is
 * refused, since what would follow is either deleting a stranger's files or committing onto
 * the wrong history.
 */
export function describeTarget(out: string, root: string): Parsed<Target> {
  if (!existsSync(out) || readdirSync(out).length === 0)
    return { ok: true, value: { kind: 'fresh' } };
  if (!existsSync(join(out, '.git'))) {
    return { ok: false, reason: `${out} is not empty and is not a git checkout` };
  }
  const top = realpathSync(git(['rev-parse', '--show-toplevel'], out));
  if (top !== realpathSync(out))
    return { ok: false, reason: `${out} is inside ${top}, not its top` };

  const ours = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const theirs = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], out);
  if (realpathSync(ours) === realpathSync(theirs)) {
    return { ok: false, reason: `${out} is this private repository, or a worktree of it` };
  }
  let roots: string[];
  try {
    roots = lines(git(['rev-list', '--max-parents=0', 'HEAD'], out));
  } catch {
    return { ok: false, reason: `${out} is a git checkout with no commits` };
  }
  for (const sha of roots) {
    try {
      git(['cat-file', '-e', `${sha}^{commit}`], root);
      return {
        ok: false,
        reason: `${out} shares its root commit ${sha.slice(0, 7)} with this repository`,
      };
    } catch {
      // Not in this repository's history, which is what a public checkout looks like.
    }
  }
  const [first] = roots;
  if (roots.length !== 1 || first === undefined) {
    return { ok: false, reason: `${out} has ${roots.length} root commits; an export has one` };
  }
  const subject = git(['log', '-1', '--format=%s', first], out);
  if (subject !== SUBJECT) {
    return { ok: false, reason: `${out} began with "${subject}", not an export's "${SUBJECT}"` };
  }
  const dirty = git(['status', '--porcelain'], out);
  if (dirty !== '') {
    return {
      ok: false,
      reason: `${out} has uncommitted changes, which the snapshot would replace`,
    };
  }
  return { ok: true, value: { kind: 'update', head: git(['rev-parse', '--short', 'HEAD'], out) } };
}

export type Replaced =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'committed'; readonly sha: string; readonly removed: readonly string[] };

/**
 * Replaces every tracked file in the checkout with the snapshot and commits the result on top.
 * Only tracked files are removed: the checkout's ignored ones (its node_modules) are its own,
 * and `describeTarget` refused it if it had untracked ones.
 *
 * `files` is the release, as the archive listed it before the gate ran. The snapshot holds more
 * by then: the first real update copied the workspaces' node_modules, whose symlinks git then
 * refused (14 Oct 2026). And it is staged by that list, not `add --all`, since an ignored file
 * in the checkout that the release's `.gitignore` no longer covers would be committed with it.
 * Forced, because every one of them was tracked in the private repository.
 */
export function replaceWith(
  snapshot: string,
  files: readonly string[],
  out: string,
  message: string,
): Replaced {
  for (const path of lines(git(['ls-files'], out))) rmSync(join(out, path), { force: true });
  for (const path of files) cpSync(join(snapshot, path), join(out, path));
  git(['add', '--update'], out);
  git(['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], out, files.join('\0'));
  try {
    git(['diff', '--cached', '--quiet'], out);
    return { kind: 'unchanged' };
  } catch {
    // A difference, which is a release.
  }
  const removed = lines(git(['diff', '--cached', '--name-only', '--diff-filter=D'], out));
  // The machine's commit hook asks every commit for its tracker ticket. The public repository
  // has no tracker, so its releases are made without asking, as its root commit was.
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message], out);
  return { kind: 'committed', sha: git(['rev-parse', '--short', 'HEAD'], out), removed };
}

/** A path as it can be pasted into zsh: an unquoted `<name>` there is a redirect. */
export function shellPath(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * What to run next, naming the copy by its full path so the command means the same from any
 * directory. On 14 Oct 2026 this said `--source .`, and run from the private checkout `.` was
 * all 203 commits of it; it failed only because zsh read `<name>` as a redirect.
 */
export function publishStep(target: Target, out: string): string {
  const path = shellPath(out);
  return target.kind === 'fresh'
    ? `gh repo create ${shellPath(basename(out))} --public --source ${path} --push`
    : `git -C ${path} push origin HEAD:main`;
}
