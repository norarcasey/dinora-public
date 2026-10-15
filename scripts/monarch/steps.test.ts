import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Mapping, MappingCopy } from '../../packages/core/src/monarch.ts';
import {
  decide,
  isWorktree,
  lastWord,
  newest,
  readArgs,
  readMappingFile,
  refusalOf,
  settle,
} from './steps.ts';

const HOME = '/Users/someone';
const USER = '11111111-1111-1111-1111-111111111111';
const argv = (...rest: string[]) => ['node', 'cli.ts', ...rest];

describe('readArgs', () => {
  it('reads the local stack, the default folder and the default user with no flags', () => {
    expect(readArgs(argv(), HOME)).toEqual({
      ok: true,
      value: {
        production: false,
        show: false,
        dir: '/Users/someone/Downloads',
        mappingFile: '/Users/someone/Downloads/monarch-accounts.json',
        email: 'one@example.test',
        link: null,
        set: null,
      },
    });
  });

  it('expands a quoted ~ in --dir and --mapping, and keeps the mapping beside --dir', () => {
    const read = readArgs(argv('--production', '--dir', '~/Documents'), HOME);
    expect(read.ok && read.value).toMatchObject({
      production: true,
      dir: '/Users/someone/Documents',
      mappingFile: '/Users/someone/Documents/monarch-accounts.json',
    });
    const mapped = readArgs(argv('--mapping', '~/elsewhere/m.json'), HOME);
    expect(mapped.ok && mapped.value.mappingFile).toBe('/Users/someone/elsewhere/m.json');
  });

  it('leaves a ~ inside a name alone', () => {
    const read = readArgs(argv('--dir', '/tmp/~old'), HOME);
    expect(read.ok && read.value.dir).toBe('/tmp/~old');
  });

  it('refuses a flag with no value rather than falling back to the default', () => {
    // `--dir --production` would otherwise have imported ~/Downloads into production.
    expect(readArgs(argv('--dir', '--production'), HOME)).toEqual({
      ok: false,
      reason: '--dir takes a value',
    });
    expect(readArgs(argv('--production', '--dir'), HOME)).toEqual({
      ok: false,
      reason: '--dir takes a value',
    });
  });

  it('takes --link only with --to', () => {
    expect(readArgs(argv('--link', 'a'), HOME).ok).toBe(false);
    expect(readArgs(argv('--to', 'b'), HOME).ok).toBe(false);
    const read = readArgs(argv('--production', '--link', 'a', '--to', 'b'), HOME);
    expect(read.ok && read.value.link).toEqual({ from: 'a', to: 'b' });
  });

  it('reads a --set with where it goes and why, trimmed', () => {
    const read = readArgs(
      argv('--set', 'Old Visa', '--as', 'asset:vehicle', '--why', '  the car  '),
      HOME,
    );
    expect(read.ok && read.value.set).toEqual({
      name: 'Old Visa',
      target: { asset: 'vehicle' },
      why: 'the car',
    });
  });

  it('refuses a --set with no --as, an --as it cannot read, or no reason', () => {
    const refused = (...rest: string[]) => {
      const read = readArgs(argv(...rest), HOME);
      return read.ok ? null : read.reason;
    };
    expect(refused('--set', 'X', '--why', 'w')).toMatch(/^--as takes/);
    expect(refused('--set', 'X', '--as', 'asset:crypto', '--why', 'w')).toMatch(/^--as takes/);
    expect(refused('--set', 'X', '--as', 'skip')).toMatch(/^--set takes --why/);
    expect(refused('--set', 'X', '--as', 'skip', '--why', '   ')).toMatch(/^--set takes --why/);
    // Once read as an account named `--as`.
    expect(refused('--set', '--as', 'skip', '--why', 'w')).toBe('--set takes a value');
  });

  it('keeps a link as the id until Dinora names it', () => {
    const read = readArgs(argv('--set', 'X', '--as', 'link:acct-9', '--why', 'w'), HOME);
    expect(read.ok && read.value.set?.target).toEqual({ link: 'acct-9' });
  });

  it('refuses --set and --link in one run', () => {
    const read = readArgs(
      argv('--set', 'X', '--as', 'skip', '--why', 'w', '--link', 'a', '--to', 'b'),
      HOME,
    );
    expect(read.ok).toBe(false);
  });
});

describe('newest', () => {
  it("takes the last of Monarch's downloads by name, of the kind asked for", () => {
    const files = [
      'Transactions_2026-09-01.csv',
      'Balances_2026-10-05.csv',
      'Transactions_2026-10-04.csv',
      'Transactions_2026-10-09.csv.crdownload',
      'Transactions_2026-10-02.csv',
      'notes.txt',
    ];
    expect(newest(files, 'Transactions_')).toBe('Transactions_2026-10-04.csv');
    expect(newest(files, 'Balances_')).toBe('Balances_2026-10-05.csv');
  });

  it('finds nothing in a folder with no download', () => {
    expect(newest(['monarch-accounts.json'], 'Transactions_')).toBeUndefined();
  });
});

describe('readMappingFile', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monarch-steps-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (text: string) => {
    const file = join(dir, 'monarch-accounts.json');
    writeFileSync(file, text);
    return file;
  };

  it('reads a mapping', () => {
    const mapping: Mapping = {
      confirmed: true,
      accounts: { 'Visa 1234': { link: 'acct-1', is: 'Chase · Visa 1234' }, Old: 'skip' },
    };
    expect(readMappingFile(write(JSON.stringify(mapping)))).toEqual({ ok: true, value: mapping });
  });

  it('says which of missing, not JSON or not a mapping the file is', () => {
    const reason = (file: string) => {
      const read = readMappingFile(file);
      return read.ok ? null : read.reason;
    };
    expect(reason(join(dir, 'none.json'))).toMatch(/could not be read\.$/);
    expect(reason(write('{ confirmed: true'))).toMatch(/is not JSON\.$/);
    expect(reason(write('{"confirmed":true,"accounts":{"X":"elsewhere"}}'))).toMatch(
      /monarch-accounts\.json: /,
    );
  });
});

describe('lastWord', () => {
  const copy = (file: string, at: string): MappingCopy => ({
    file,
    decided_at: at,
    mapping: { confirmed: true, accounts: {} },
  });

  it('keeps the file at its own time when every copy is older', () => {
    const now = copy('monarch-accounts.json', '2026-09-28T10:00:00.000Z');
    const older = [copy('a.json', '2026-09-20T00:00:00.000Z')];
    expect(lastWord(older, now)).toEqual([...older, now]);
  });

  it('puts the file after a copy touched later, so it stays the last word', () => {
    const now = copy('monarch-accounts.json', '2026-09-28T10:00:00.000Z');
    const touched = copy('b.json', '2026-09-29T00:00:00.000Z');
    const ordered = lastWord([touched], now);
    expect(ordered.at(-1)).toEqual({ ...now, decided_at: '2026-09-29T00:00:00.001Z' });
  });
});

describe('decide', () => {
  const decision = {
    monarch_name: 'Old',
    goes: 'skip' as const,
    link: null,
    link_is: null,
    asset_kind: null,
    why: 'closed',
    decided_at: '2026-10-14T00:00:00.000Z',
  };

  it('asks nothing for no decisions', () => {
    const query = () => {
      throw new Error('asked');
    };
    expect(decide(query, USER, [])).toEqual({ ok: true, value: 0 });
  });

  it('answers how many the database wrote', () => {
    const asked: string[] = [];
    const query = (sql: string) => {
      asked.push(sql);
      return '{"decided": 1}';
    };
    expect(decide(query, USER, [decision])).toEqual({ ok: true, value: 1 });
    expect(asked).toHaveLength(1);
  });

  it("gives the database's reason for a refusal and says nothing was written", () => {
    const query = () => {
      throw Object.assign(new Error('exit 1'), {
        stdout: '',
        stderr: '{"error": {"message": "failed to execute query: error: no such account"}}',
      });
    };
    const read = decide(query, USER, [decision]);
    expect(read.ok ? null : read.reason).toMatch(/^the mapping was refused: /);
    expect(read.ok ? null : read.reason).toMatch(/Nothing of it was written\.$/);
  });

  it('refuses an answer it cannot read rather than counting it', () => {
    expect(decide(() => 'nonsense', USER, [decision]).ok).toBe(false);
  });
});

describe('refusalOf', () => {
  it('says so when the refused command printed nothing it can read', () => {
    expect(refusalOf(new Error('spawn npx ENOENT'))).toBe('it printed no reason');
    expect(refusalOf('not an error')).toBe('it printed no reason');
  });
});

describe('settle', () => {
  const mapping: Mapping = { confirmed: true, accounts: { Old: 'skip' } };
  const NOW = '2026-10-14T12:00:00.000Z';
  const never = () => {
    throw new Error('read the accounts');
  };

  it('writes nothing when the account already goes there', () => {
    expect(settle({ name: 'Old', target: 'skip', why: 'w' }, mapping, never, NOW)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('writes a decision that changes where it goes, without reading the accounts', () => {
    const read = settle({ name: 'Old', target: 'history', why: 'keep it' }, mapping, never, NOW);
    expect(read.ok && read.value).toMatchObject({
      monarch_name: 'Old',
      goes: 'history',
      why: 'keep it',
      decided_at: NOW,
    });
  });

  it("names a link from Dinora's own account", () => {
    const accounts = () => [{ source_id: 'acct-9', institution: 'Chase', name: 'Visa 1234' }];
    const read = settle(
      { name: 'Visa', target: { link: 'acct-9' }, why: 'w' },
      mapping,
      accounts,
      NOW,
    );
    expect(read.ok && read.value).toMatchObject({
      goes: 'link',
      link: 'acct-9',
      link_is: 'Chase · Visa 1234',
    });
  });

  it('refuses a link to an account Dinora does not have', () => {
    const read = settle(
      { name: 'Visa', target: { link: 'nope' }, why: 'w' },
      mapping,
      () => [],
      NOW,
    );
    expect(read).toEqual({ ok: false, reason: 'no bank account in Dinora is nope.' });
  });
});

describe('isWorktree', () => {
  let dir = '';
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
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monarch-worktree-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('tells the main checkout, where --production may run, from a worktree of it', () => {
    const main = join(dir, 'main');
    mkdirSync(main);
    git(['init', '--quiet', '--initial-branch=main'], main);
    git(['commit', '--quiet', '--allow-empty', '-m', 'first'], main);
    git(['worktree', 'add', '--quiet', join(dir, 'tree')], main);
    mkdirSync(join(main, 'scripts'));

    expect(isWorktree(main)).toBe(false);
    expect(isWorktree(join(main, 'scripts'))).toBe(false);
    expect(isWorktree(join(dir, 'tree'))).toBe(true);
  });
});
