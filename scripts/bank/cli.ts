/**
 * SimpleFIN by hand, against this checkout's local stack only. Made for the spike (BANK-01);
 * a pull stores through `public.bank_store`, as the nightly cron does (BANK-02).
 *
 *   pnpm bank:claim                   reads a setup token on stdin, claims it once, and keeps
 *                                     the access URL in the main checkout's .env.simplefin
 *   pnpm bank:pull [--demo] [--windows N] [--email one@example.test]
 *                                     pulls up to N 45-day windows back from now, stopping
 *                                     at the first empty one, and stores them for that user
 *
 * The access URL is a credential (read-only by construction, which is invariant 5), so it is
 * read from stdin rather than argv — argv lands in shell history — kept in a 0600 file, and
 * never printed. What a pull prints is counts, dates and signs: no amount and no payee
 * (invariant 4), a spike included.
 *
 * The Bridge allows 24 requests a day per access URL (docs, read 24 Sep 2026), and every
 * window is one. The default of eight — a year — spends at most eight, and fewer when the
 * bank runs out of history first, which is the first empty window.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DEMO_ACCESS_URL, access, pull } from '../../api/_lib/simplefin.ts';
import {
  detail,
  dropsFrom,
  historyFrom,
  report,
  windows,
} from '../../packages/core/src/simplefin.ts';
import { flag } from '../argv.ts';
import { stack } from '../db/stack.ts';
import { claimUrl, storeSql } from './simplefin.ts';

function fail(message: string): never {
  console.error(`bank: ${message}`);
  process.exit(1);
}

/**
 * The credential lives beside the main checkout, not in a worktree: a worktree is removed
 * when its branch merges, and the setup token that made the credential cannot be claimed a
 * second time.
 */
function credentialFile(): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return join(dirname(common), '.env.simplefin');
}

const KEY = 'SIMPLEFIN_ACCESS_URL';

function readAccessUrl(): string | null {
  const fromEnv = process.env[KEY];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const file = credentialFile();
  if (!existsSync(file)) return null;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${KEY}=`));
  return line === undefined ? null : line.slice(KEY.length + 1).trim();
}

async function stdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Paste the SimpleFIN setup token, then Ctrl-D:\n');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.trim();
}

async function claim(): Promise<void> {
  const file = credentialFile();
  if (existsSync(file)) {
    fail(
      `${file} already exists. A second claim would replace a working credential; remove it first if that is meant.`,
    );
  }
  const url = claimUrl(await stdin());
  if (url === null) fail('that is not a setup token: it should be base64 of an https URL.');

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (response.status === 403) {
    fail(
      'the Bridge refused the token (403): it was already claimed, or is not valid.\n' +
        'If nobody here claimed it, disable it at the Bridge — someone else may hold the access URL.',
    );
  }
  if (!response.ok) fail(`the claim failed with HTTP ${response.status}.`);
  const accessUrl = (await response.text()).trim();
  if (access(accessUrl) === null) fail('the claim answered, but not with an access URL.');

  writeFileSync(
    file,
    `# SimpleFIN access URL, claimed ${new Date().toISOString()}. A credential: never commit, never print.\n${KEY}=${accessUrl}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  console.log(`bank: claimed. The access URL is in ${file} (0600).`);
}

async function pullCommand(): Promise<void> {
  const demo = process.argv.includes('--demo');
  const windowsFlag = flag(process.argv, '--windows');
  if (!windowsFlag.ok) fail(windowsFlag.reason);
  const count = Number(windowsFlag.value ?? '8');
  if (!Number.isInteger(count) || count < 1 || count > 12) {
    fail('--windows is 1 to 12, of the 24 requests a day the Bridge allows.');
  }
  const emailFlag = flag(process.argv, '--email');
  if (!emailFlag.ok) fail(emailFlag.reason);
  const email = emailFlag.value ?? 'one@example.test';

  const accessUrl = demo ? DEMO_ACCESS_URL : readAccessUrl();
  if (accessUrl === null) fail('no access URL. Claim a setup token first: pnpm bank:claim');
  const credential = access(accessUrl);
  if (credential === null) fail(`${KEY} is not an https access URL with credentials in it.`);

  // Resolved before any request, so a stack that is down does not waste the day's budget.
  const s = await stack(process.cwd(), false);
  const container = `supabase_db_${s.projectId}`;
  const psql = (input: string): string =>
    execFileSync(
      'docker',
      ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-q'],
      { input, encoding: 'utf8' },
    ).trim();
  const userId = psql(
    `select id from auth.users where email = lower('${email.replace(/'/g, "''")}');`,
  );
  if (userId === '') fail(`no user ${email} in this checkout's local database.`);

  const startedAt = new Date();
  const now = Math.floor(startedAt.getTime() / 1000);
  const pulled = await pull(credential, windows(now, count), {
    fetch,
    order: 'untilEmpty',
    onWindow: (window, transactions) => {
      const from = new Date(window.start * 1000).toISOString().slice(0, 10);
      console.log(`window from ${from}: ${transactions} transaction(s)`);
    },
  });
  if (!pulled.ok) fail(`${pulled.reason}, after ${pulled.requests} request(s).`);

  const { rows } = pulled;
  console.log(`\n${pulled.requests} request(s) to ${new URL(credential.base).host}`);
  for (const e of rows.errors) console.log(`bridge said  ${e}`);
  for (const s of rows.skipped) {
    const what = s.kind === 'transaction' ? `, transaction ${s.transaction}` : '';
    console.log(`skipped      ${s.label} (${s.account}${what}): ${s.why}`);
  }
  console.log('');
  console.table(report(rows));

  const run = {
    startedAt: startedAt.toISOString(),
    requests: pulled.requests,
    dropsFrom: dropsFrom(rows, pulled.covered, now),
    historyFrom: historyFrom(rows, pulled.covered, now),
    detail: detail(rows),
  };
  console.log(psql(storeSql(userId, rows, run)));
}

const command = process.argv[2];
if (command === 'claim') await claim();
else if (command === 'pull') await pullCommand();
else fail('usage: cli.ts claim | pull [--demo] [--windows N] [--email address]');
