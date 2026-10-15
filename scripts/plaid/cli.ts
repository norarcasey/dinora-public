/**
 * Plaid by hand, for the spike (BANK-06): can it reach the Harbor mortgage and the Human
 * Interest 401(k), and what does it send for them? Only `--store` writes, and only to the
 * local stack.
 *
 *   pnpm plaid:keys                   reads the client id, secret and environment on stdin
 *                                     and keeps them in the main checkout's .env.plaid
 *   pnpm plaid:institutions [name…]   which read products Plaid lists for each institution;
 *                                     Harbor Mortgage and Fabrikam by default
 *   pnpm plaid:link <product>         opens Plaid Link on 127.0.0.1 for one read product and
 *                                     keeps the access token beside the keys
 *   pnpm plaid:relink <bank | n>      signs a linked item in again, the bank as the home
 *                                     screen names it or the item by its place (BANK-11)
 *   pnpm plaid:relink <bank | n> --add transactions
 *                                     and asks her consent to one more read for it, which
 *                                     the nightly then reads (BANK-14)
 *   pnpm plaid:pull                   what each linked account sends, by type, sign and field
 *   pnpm plaid:pull --store [--email one@example.test]
 *                                     and then the rows the nightly would store (BANK-07),
 *                                     stored into this checkout's local stack as that user
 *
 * The keys and every access token are credentials, kept like SimpleFIN's access URL
 * (`scripts/bank/cli.ts`): read from stdin, a 0600 file beside the main checkout, never
 * printed. What is printed is types, signs, counts and field names (invariant 4).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { call, plaidEnv, pullItems, wellFormed } from '../../api/_lib/plaid.ts';
import type { PlaidKeys } from '../../api/_lib/plaid.ts';
import {
  READ_PRODUCTS,
  consentRequest,
  institutionName,
  linkTokenRequest,
  parseInstitutions,
  plaidRows,
  readProduct,
  shape,
  updateTokenRequest,
  whichItem,
} from '../../packages/core/src/plaid.ts';
import { parse } from '../../packages/core/src/parse.ts';
import { detail, report } from '../../packages/core/src/simplefin.ts';
import { storeSql } from '../bank/simplefin.ts';
import { flag } from '../argv.ts';
import { stack } from '../db/stack.ts';
import type { Item } from './keys.ts';
import {
  items as itemsIn,
  nextItem,
  readCredentials,
  readKeys as readKeysIn,
  relinkArgs,
} from './keys.ts';
import { linkPage } from './page.ts';

function fail(message: string): never {
  console.error(`plaid: ${message}`);
  process.exit(1);
}

/** Beside the main checkout, for the reason `.env.simplefin` is: a worktree is removed. */
function credentialFile(): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return join(dirname(common), '.env.plaid');
}

function lines(): Map<string, string> {
  const file = credentialFile();
  return existsSync(file) ? readCredentials(readFileSync(file, 'utf8')) : new Map<string, string>();
}

function readKeys(): PlaidKeys {
  const keys = readKeysIn(lines(), credentialFile());
  if (!keys.ok) fail(keys.reason);
  return keys.value;
}

function items(): Item[] {
  return itemsIn(lines());
}

async function stdin(): Promise<string[]> {
  if (process.stdin.isTTY) {
    process.stderr.write(
      'Paste three lines: client id, secret, environment (sandbox or production), then Ctrl-D:\n',
    );
  }
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

async function keysCommand(): Promise<void> {
  const file = credentialFile();
  if (existsSync(file)) {
    fail(`${file} already exists, and may hold access tokens. Remove it first if that is meant.`);
  }
  const [clientId, secret, envName] = await stdin();
  const env = plaidEnv(envName ?? '');
  if (clientId === undefined || secret === undefined || env === null) {
    fail('expected a client id, a secret, and sandbox or production.');
  }
  if (!wellFormed(clientId, secret)) {
    fail(
      "that is not Plaid's form (24 and 30 hex characters): look for a quote, a space or a \\ carried in with the paste.",
    );
  }
  writeFileSync(
    file,
    `# Plaid keys, kept ${new Date().toISOString()}. Credentials: never commit, never print.\n` +
      `PLAID_CLIENT_ID=${clientId}\nPLAID_SECRET=${secret}\nPLAID_ENV=${env}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  console.log(`plaid: kept ${env} keys in ${file} (0600).`);
}

async function institutionsCommand(): Promise<void> {
  const keys = readKeys();
  const names = process.argv.slice(3);
  for (const query of names.length > 0 ? names : ['Harbor Mortgage', 'Fabrikam']) {
    const called = await call(
      keys,
      '/institutions/search',
      { query, country_codes: ['US'] },
      fetch,
    );
    if (!called.ok) fail(called.reason);
    const found = parseInstitutions(called.body);
    if (!found.ok)
      fail(`the answer for "${query}" did not parse (${found.issues.length} issue(s))`);
    console.log(`\n"${query}": ${found.value.length} institution(s)`);
    if (found.value.length > 0) {
      console.table(found.value.map((i) => ({ ...i, reads: i.reads.join(' ') || '(none)' })));
    }
  }
}

const exchangeSchema = z.object({ access_token: z.string().min(1), item_id: z.string() });
const linkTokenSchema = z.object({ link_token: z.string().min(1) });
const publicTokenSchema = z.object({ public_token: z.string().min(1) });
// Plaid's own words for where Link stopped and which session it was, never a person's.
const said = z
  .string()
  .regex(/^[\w./-]{1,100}$/)
  .nullable()
  .catch(null);
const exitSchema = z.object({ code: said, status: said, session: said });
const accountsSchema = z.object({ accounts: z.array(z.unknown()) });

/** Makes a link token from `request`, opens Link on it, and answers Link's public token. */
async function runLink(
  keys: PlaidKeys,
  request: Record<string, unknown>,
  what: string,
): Promise<string> {
  const made = await call(keys, '/link/token/create', request, fetch);
  if (!made.ok) fail(made.reason);
  const token = parse(linkTokenSchema, made.body);
  if (!token.ok) fail('Plaid made no link token.');

  let resolve: (publicToken: string) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const finished = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(linkPage(token.value.link_token));
      return;
    }
    if (request.method === 'POST' && request.url === '/done') {
      let body = '';
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        response.writeHead(204).end();
        try {
          const got = parse(publicTokenSchema, JSON.parse(body));
          if (got.ok) resolve(got.value.public_token);
          else reject(new Error('Link finished without a public token'));
        } catch {
          reject(new Error('Link finished with something other than JSON'));
        }
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/exit') {
      // Link's error is about the connection (BANK-08: Fabrikam could not connect, and
      // nothing said why), so its type and code are printed; its messages are not. Closed from
      // a failure screen, Link can hand back no error at all, so where it stopped and its
      // session id are printed too: the id is what Plaid's support asks for.
      let body = '';
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        response.writeHead(204).end();
        let why: string[] = [];
        try {
          const got = parse(exitSchema, JSON.parse(body));
          if (got.ok) {
            const { code, status, session } = got.value;
            why = [
              code,
              status === null ? null : `at ${status}`,
              session === null ? null : `session ${session}`,
            ].filter((w) => w !== null);
          }
        } catch {
          why = [];
        }
        const told = why.length === 0 ? '' : `: ${why.join(', ')}`;
        reject(new Error(`Link was closed before an account was linked${told}`));
      });
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') fail('the local page has no port.');
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`plaid: Link for ${what} is at ${url} — opening it.`);
  execFileSync('open', [url]);

  try {
    return await finished;
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Link failed');
  } finally {
    server.close();
  }
}

async function linkCommand(): Promise<void> {
  const product = readProduct(process.argv[3] ?? '');
  if (product === null) fail(`link one read product: ${READ_PRODUCTS.join(', ')}.`);
  const keys = readKeys();
  const publicToken = await runLink(keys, linkTokenRequest(product, 'owner'), product);

  const exchanged = await call(
    keys,
    '/item/public_token/exchange',
    { public_token: publicToken },
    fetch,
  );
  if (!exchanged.ok) fail(exchanged.reason);
  const item = parse(exchangeSchema, exchanged.body);
  if (!item.ok) fail('the exchange answered without an access token.');
  const n = nextItem(lines());
  appendFileSync(credentialFile(), `PLAID_ITEM_${n}=${product} ${item.value.access_token}\n`);
  chmodSync(credentialFile(), 0o600);
  console.log(
    `plaid: linked item ${n} for ${product}. Its access token is in ${credentialFile()}.`,
  );
}

/**
 * Link's update mode on an item already linked (BANK-11). `plaid:link` would make a second
 * item, and with it a second copy of every account the bank holds. The public token Link hands
 * back is not exchanged: the item keeps the access token it had, so neither this file nor
 * production's `PLAID_ACCESS_TOKENS` changes, and the next nightly simply answers again.
 */
async function relinkCommand(): Promise<void> {
  const relink = relinkArgs(process.argv.slice(3));
  if (!relink.ok) fail(relink.reason);
  const { wanted, adding } = relink.value;
  const keys = readKeys();
  const linked = items();
  if (linked.length === 0) fail('nothing linked yet: pnpm plaid:link <product>');
  // `/item/get` still answers for an item that wants signing in again (UI-09).
  const names = await Promise.all(
    linked.map(async ({ token }) => {
      const got = await call(keys, '/item/get', { access_token: token }, fetch);
      return got.ok ? institutionName(got.body) : null;
    }),
  );
  if (wanted.trim() === '') {
    fail(`say which bank: ${names.map((n, i) => `${i + 1} ${n ?? '(no name)'}`).join(', ')}`);
  }
  const picked = whichItem(wanted, names);
  if (!picked.ok) fail(picked.reason);
  const n = picked.index + 1;
  const { token } = linked[picked.index] ?? fail(`no item ${n}.`);
  const bank = names[picked.index] ?? `item ${n}'s bank`;

  const request =
    adding === null ? updateTokenRequest(token, 'owner') : consentRequest(token, 'owner', adding);
  await runLink(keys, request, bank);

  const accounts = await call(keys, '/accounts/get', { access_token: token }, fetch);
  if (!accounts.ok) fail(`${bank} was signed in, but still refuses: ${accounts.reason}`);
  const listed = parse(accountsSchema, accounts.body);
  const count = listed.ok ? `${listed.value.accounts.length} account(s)` : 'an answer';
  const consented = adding === null ? '' : `, consented to ${adding}`;
  console.log(
    `plaid: signed ${bank} in again${consented}, and it answers with ${count}. ` +
      'Its access token is the one it had: nothing to change here or in production.',
  );
}

async function pullCommand(): Promise<void> {
  const keys = readKeys();
  const linked = items();
  if (linked.length === 0) fail('nothing linked yet: pnpm plaid:link <product>');
  for (const [i, { product, token }] of linked.entries()) {
    const accounts = await call(keys, '/accounts/get', { access_token: token }, fetch);
    if (!accounts.ok) fail(`item ${i + 1}: ${accounts.reason}`);
    // Only the product the item was linked for: asking for another adds it to the item.
    const liabilities =
      product === 'liabilities'
        ? await call(keys, '/liabilities/get', { access_token: token }, fetch)
        : null;
    if (liabilities !== null && !liabilities.ok) fail(`item ${i + 1}: ${liabilities.reason}`);
    const holdings =
      product === 'investments'
        ? await call(keys, '/investments/holdings/get', { access_token: token }, fetch)
        : null;
    if (holdings !== null && !holdings.ok) fail(`item ${i + 1}: ${holdings.reason}`);

    const shaped = shape({
      accounts: accounts.body,
      liabilities: liabilities?.body ?? null,
      holdings: holdings?.body ?? null,
    });
    if (!shaped.ok) fail(`item ${i + 1}: an answer did not parse (${shaped.issues} issue(s))`);
    console.log(`\nitem ${i + 1}, linked for ${product}: ${shaped.value.length} account(s)`);
    console.table(shaped.value);
  }
}

/** What `plaidNightly` would store, stored locally through the same `bank_store`. */
async function storeCommand(): Promise<void> {
  const keys = readKeys();
  const emailFlag = flag(process.argv, '--email');
  if (!emailFlag.ok) fail(emailFlag.reason);
  const email = emailFlag.value ?? 'one@example.test';
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

  const startedAt = new Date().toISOString();
  const tokens = items().map((i) => i.token);
  const pulled = await pullItems(keys, tokens, fetch);
  if (!pulled.ok) fail(pulled.reason);
  const read = plaidRows(pulled.items, startedAt, pulled.warnings);
  if (!read.ok) fail(read.reason);
  console.log('');
  console.table(report(read.rows));
  for (const skip of read.rows.skipped) {
    console.log(`skipped      ${skip.label} (${skip.account}): ${skip.why}`);
  }
  const run = { startedAt, requests: pulled.requests, dropsFrom: null, historyFrom: null };
  console.log(psql(storeSql(userId, read.rows, { ...run, detail: detail(read.rows) }, 'plaid')));
}

const command = process.argv[2];
if (command === 'keys') await keysCommand();
else if (command === 'institutions') await institutionsCommand();
else if (command === 'link') await linkCommand();
else if (command === 'relink') await relinkCommand();
else if (command === 'pull' && process.argv.includes('--store')) await storeCommand();
else if (command === 'pull') await pullCommand();
else fail('usage: cli.ts keys | institutions [name…] | link <product> | relink <bank | n> | pull');
