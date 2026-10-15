import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeTarget, publishStep, replaceWith, shellPath, SUBJECT } from './checkout.ts';

// CI has no git identity and this machine's global hook asks every commit for a ticket.
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
};

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function repo(dir: string, files: Record<string, string>, subject: string): string {
  mkdirSync(dir, { recursive: true });
  git(['init', '--quiet', '--initial-branch=main'], dir);
  write(dir, files);
  git(['add', '--all'], dir);
  git(['commit', '--quiet', '-m', subject], dir);
  return dir;
}

let base: string;
let root: string;
const saved = { ...process.env };

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'checkout-test-'));
  root = repo(join(base, 'private'), { 'README.md': 'private\n' }, 'The first private commit');
  Object.assign(process.env, ENV);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  process.env = { ...saved };
});

describe('describeTarget', () => {
  it('takes a directory that is missing or empty as a new copy', () => {
    expect(describeTarget(join(base, 'missing'), root)).toEqual({
      ok: true,
      value: { kind: 'fresh' },
    });
    mkdirSync(join(base, 'empty'));
    expect(describeTarget(join(base, 'empty'), root)).toEqual({
      ok: true,
      value: { kind: 'fresh' },
    });
  });

  it('takes a clean checkout whose history began with an export, at its head', () => {
    const out = repo(join(base, 'public'), { 'README.md': 'public\n' }, SUBJECT);
    write(out, { LICENSE: 'MIT\n' });
    git(['add', '--all'], out);
    git(['commit', '--quiet', '-m', 'MIT license'], out);
    expect(describeTarget(out, root)).toEqual({
      ok: true,
      value: { kind: 'update', head: git(['rev-parse', '--short', 'HEAD'], out) },
    });
  });

  it('refuses the private repository, a worktree of it and a clone of it', () => {
    expect(describeTarget(root, root)).toMatchObject({
      ok: false,
      reason: /this private repository/,
    });

    const worktree = join(base, 'worktree');
    git(['worktree', 'add', '--quiet', '-b', 'side', worktree], root);
    expect(describeTarget(worktree, root)).toMatchObject({
      ok: false,
      reason: /this private repository/,
    });

    const clone = join(base, 'clone');
    git(['clone', '--quiet', root, clone], base);
    expect(describeTarget(clone, root)).toMatchObject({
      ok: false,
      reason: /shares its root commit/,
    });
  });

  it('refuses a directory it would have to delete a stranger’s files from', () => {
    write(join(base, 'loose'), { 'notes.txt': 'mine\n' });
    expect(describeTarget(join(base, 'loose'), root)).toMatchObject({
      ok: false,
      reason: /not a git checkout/,
    });

    const other = repo(join(base, 'other'), { 'a.txt': 'a\n' }, 'Something else');
    expect(describeTarget(other, root)).toMatchObject({
      ok: false,
      reason: /began with "Something else"/,
    });

    mkdirSync(join(base, 'unborn'));
    git(['init', '--quiet'], join(base, 'unborn'));
    expect(describeTarget(join(base, 'unborn'), root)).toMatchObject({
      ok: false,
      reason: /no commits/,
    });
  });

  it('refuses a subdirectory of the checkout and a checkout with uncommitted work', () => {
    const out = repo(join(base, 'public'), { 'docs/a.md': 'a\n' }, SUBJECT);
    expect(describeTarget(join(out, 'docs'), root)).toMatchObject({
      ok: false,
      reason: /not its top/,
    });

    write(out, { 'scratch.txt': 'wip\n' });
    expect(describeTarget(out, root)).toMatchObject({ ok: false, reason: /uncommitted changes/ });
  });
});

describe('replaceWith', () => {
  it('commits the snapshot as a child of the last release, deleting what it no longer has', () => {
    const out = repo(
      join(base, 'public'),
      { 'README.md': 'old\n', 'gone.ts': 'x\n', 'docs/kept.md': 'same\n' },
      SUBJECT,
    );
    const before = git(['rev-parse', 'HEAD'], out);
    write(out, { 'node_modules/dep.js': 'installed\n', '.gitignore': 'node_modules\n' });
    git(['add', '--all'], out);
    git(['commit', '--quiet', '-m', 'ignore deps'], out);
    const parent = git(['rev-parse', 'HEAD'], out);

    const snapshot = join(base, 'snapshot');
    write(snapshot, { 'README.md': 'new\n', 'docs/kept.md': 'same\n', 'added.ts': 'y\n' });
    // What the gate installs beside the release is not part of it.
    write(snapshot, { 'apps/web/node_modules/dep.js': 'installed\n' });

    const replaced = replaceWith(
      snapshot,
      ['README.md', 'docs/kept.md', 'added.ts'],
      out,
      `${SUBJECT}\n\nFrom abc1234.`,
    );

    expect(replaced).toEqual({
      kind: 'committed',
      sha: git(['rev-parse', '--short', 'HEAD'], out),
      removed: ['.gitignore', 'gone.ts'],
    });
    expect(git(['rev-parse', 'HEAD^'], out)).toBe(parent);
    expect(git(['merge-base', '--is-ancestor', before, 'HEAD'], out)).toBe('');
    expect(git(['ls-files'], out).split('\n')).toEqual(['README.md', 'added.ts', 'docs/kept.md']);
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('new\n');
    expect(git(['log', '-1', '--format=%B'], out)).toBe(`${SUBJECT}\n\nFrom abc1234.`);
    // Ignored files are the checkout's own, not the release's.
    expect(existsSync(join(out, 'node_modules/dep.js'))).toBe(true);
    expect(git(['status', '--porcelain'], out)).toBe('?? node_modules/');
    expect(existsSync(join(out, 'apps'))).toBe(false);
  });

  it('commits nothing when the snapshot is the tree already there', () => {
    const out = repo(join(base, 'public'), { 'README.md': 'same\n' }, SUBJECT);
    const head = git(['rev-parse', 'HEAD'], out);
    write(join(base, 'snapshot'), { 'README.md': 'same\n' });

    expect(replaceWith(join(base, 'snapshot'), ['README.md'], out, SUBJECT)).toEqual({
      kind: 'unchanged',
    });
    expect(git(['rev-parse', 'HEAD'], out)).toBe(head);
  });
});

describe('publishStep', () => {
  it('names the copy by its full path and the repository by a real name, never `.`', () => {
    const step = publishStep({ kind: 'fresh' }, '/Users/nora/src/dinora-public');
    expect(step).toBe(
      'gh repo create dinora-public --public --source /Users/nora/src/dinora-public --push',
    );
    expect(step).not.toMatch(/[<>]|\s\.(\s|$)/);
  });

  it('pushes a release from the checkout it was committed in, by path', () => {
    expect(publishStep({ kind: 'update', head: 'abc1234' }, '/src/dinora-public')).toBe(
      'git -C /src/dinora-public push origin HEAD:main',
    );
  });

  it('quotes a path the shell would split or redirect', () => {
    expect(shellPath('/src/my copy')).toBe(`'/src/my copy'`);
    expect(shellPath(`/src/it's`)).toBe(`'/src/it'\\''s'`);
    expect(shellPath('/src/<name>')).toBe(`'/src/<name>'`);
  });
});
