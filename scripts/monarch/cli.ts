/**
 * Monarch's history into Dinora (ACCT-05), from the CSV export on this laptop.
 *
 *   pnpm monarch:import [--dir ~/Downloads] [--email one@example.test]
 *                                     this checkout's local stack
 *   pnpm monarch:import --production [--dir ~/Downloads]
 *                                     the linked hosted project, from the main checkout only
 *
 * Which Monarch account is which of Dinora's is kept in Dinora (ACCT-18), in
 * `public.monarch_decisions`: every decision, with when and why, the latest of each the one
 * that counts. Before any is kept, the first run writes `monarch-accounts.json` beside the
 * files, guessed from the last four digits, and imports nothing until Nora has read it,
 * marked any account she does not want as "skip", and set "confirmed" to true. The run after
 * that reads the file into Dinora once, with every `monarch-accounts.*.json` copy beside it
 * or in `--dir` as the history before it, and never reads a file again.
 *
 *   pnpm monarch:import [--production] --mapping ~/Documents/monarch-accounts.json
 *                                     that first read, from a file not in `--dir`
 *   pnpm monarch:import [--production] --show
 *                                     every decision, and the mapping they add up to
 *   pnpm monarch:import [--production] --set "<Monarch name>" --as <where> --why "<why>"
 *                                     a new decision, where `<where>` is history, skip,
 *                                     asset:<home|vehicle|valuables> or link:<the Bridge's id>.
 *                                     Written, not imported: the next run imports with it.
 *
 * An account she wants in as something she owns rather than an account — the apartment, the
 * car, jewelry, silver (ACCT-06) — she marks `{ "asset": "home" }`, `"vehicle"` or
 * `"valuables"`. It comes in as an asset with the days Monarch's value changed.
 *
 * Every run after that imports every account again, and a second run with the same files
 * writes nothing: `monarch_store` upserts on Monarch's ids and changes only what differs.
 *
 *   pnpm monarch:import --production --link <monarch account id> --to <bank account id>
 *
 * puts together an account a bank started reading after its Monarch history was imported
 * (BANK-15): the command the home screen shows under *may be counted twice*. It links the
 * one in the mapping and imports, which moves the history onto the bank's account and retires
 * the Monarch copy. The link is kept as a decision the moment that account is stored: not
 * sooner, so a refused link leaves the mapping as it was, and not at the end, since a later
 * account's refusal would leave it saying `history` of a copy the database has already
 * retired. The decision it replaces stays, as what the mapping said before.
 *
 * What it prints is file names, account names, counts and dates: never an amount and never
 * a merchant (invariant 4).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { Decision, Mapping, MappingCopy, Stored } from '../../packages/core/src/monarch.ts';
import {
  NOTHING_STORED,
  addStored,
  decisionOf,
  describeUnready,
  linkPair,
  mappingOf,
  parseMapping,
  plan,
  proposeMapping,
  readBalances,
  readTarget,
  readTransactions,
  replay,
  sameTarget,
  strangers,
  wroteNothing,
} from '../../packages/core/src/monarch.ts';
import { stack } from '../db/stack.ts';
import {
  accountsSql,
  assetSql,
  decideSql,
  decisionsSql,
  linkAccountsSql,
  readAccounts,
  readAssetStored,
  readDecisions,
  readDecisionsWritten,
  readLinkAccounts,
  readRefusal,
  readStored,
  readUnready,
  readUserIds,
  storeSql,
  unreadySql,
  userSql,
} from './sql.ts';

function fail(message: string): never {
  console.error(`monarch: ${message}`);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Monarch names each download by the time it was made, so the newest is the last by name. */
function newest(dir: string, prefix: string): string {
  const found = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .sort();
  const last = found.at(-1);
  if (last === undefined) fail(`no ${prefix}*.csv in ${dir}. Download it from Monarch first.`);
  return join(dir, last);
}

const production = process.argv.includes('--production');
const linkFrom = flag('--link');
const linkTo = flag('--to');
if ((linkFrom === undefined) !== (linkTo === undefined)) {
  fail('--link takes the Monarch account and --to the bank account; give both or neither.');
}
const dir = (flag('--dir') ?? join(homedir(), 'Downloads')).replace(/^~(?=\/|$)/, homedir());
const mappingFile = (flag('--mapping') ?? join(dir, 'monarch-accounts.json')).replace(
  /^~(?=\/|$)/,
  homedir(),
);
const setName = flag('--set');

/**
 * Production is written from the main checkout, after the branch has merged: a worktree's
 * migrations may not be the ones production has, and `monarch_store` must be.
 */
function isWorktree(): boolean {
  const git = (arg: string) =>
    execFileSync('git', ['rev-parse', '--path-format=absolute', arg], { encoding: 'utf8' }).trim();
  return git('--git-dir') !== git('--git-common-dir');
}

type Query = (sql: string) => string;

/** The database's reason for a refused query, from what the refused command printed. */
function refusalOf(error: unknown): string {
  const printed = (stream: unknown) => (typeof stream === 'string' ? stream : '');
  const output =
    error instanceof Error && 'stdout' in error && 'stderr' in error
      ? `${printed(error.stdout)}\n${printed(error.stderr)}`
      : '';
  return readRefusal(output) ?? 'it printed no reason';
}

async function target(): Promise<Query> {
  if (production) {
    if (isWorktree()) fail('--production runs from the main checkout, after the branch merges.');
    return (sql) => {
      // A file rather than an argument: a payload is megabytes, and argv lands in `ps`.
      const scratch = mkdtempSync(join(tmpdir(), 'monarch-'));
      const file = join(scratch, 'query.sql');
      writeFileSync(file, sql, { mode: 0o600 });
      try {
        return execFileSync(
          'npx',
          ['supabase', 'db', 'query', '--linked', '--output-format', 'json', '-f', file],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' },
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    };
  }
  const s = await stack(process.cwd(), false);
  const container = `supabase_db_${s.projectId}`;
  return (sql) =>
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-At',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' },
    );
}

function describeMapping(mapping: Mapping, notes: ReadonlyMap<string, string> = new Map()): void {
  const rows = Object.entries(mapping.accounts).map(([monarch, t]) => ({
    monarch,
    goes:
      t === 'history'
        ? 'history only'
        : t === 'skip'
          ? 'skipped'
          : 'asset' in t
            ? `asset: ${t.asset}`
            : `→ ${t.is ?? t.link}`,
    ...(notes.size > 0 ? { note: notes.get(monarch) ?? '' } : {}),
  }));
  console.table(rows);
}

const query = await target();
const users = readUserIds(
  query(userSql(production ? null : (flag('--email') ?? 'one@example.test'))),
);
if (!users.ok || users.value.length !== 1) {
  fail(
    production
      ? 'production does not have exactly one user, so whose rows these are is not known.'
      : "no such user in this checkout's local database.",
  );
}
const [onlyUser] = users.value;
if (onlyUser === undefined) fail('no user.');
const userId: string = onlyUser;

function readExport() {
  const transactionsFile = newest(dir, 'Transactions_');
  const balancesFile = newest(dir, 'Balances_');
  const transactions = readTransactions(readFileSync(transactionsFile, 'utf8'));
  if (!transactions.ok) fail(`${transactionsFile}: ${transactions.reason}`);
  const balances = readBalances(readFileSync(balancesFile, 'utf8'));
  if (!balances.ok) fail(`${balancesFile}: ${balances.reason}`);

  console.log(`transactions  ${transactionsFile}: ${transactions.rows.length} read`);
  console.log(`balances      ${balancesFile}: ${balances.rows.length} read`);
  for (const s of [...transactions.skipped, ...balances.skipped]) console.log(`  skipped ${s}`);
  const tagged = transactions.rows.filter((t) => t.tagged).length;
  if (tagged > 0) console.log(`  ${tagged} transaction(s) carry tags, which are not kept`);
  return { transactions: transactions.rows, balances: balances.rows };
}

function readDecided(): readonly Decision[] {
  const read = readDecisions(query(decisionsSql(userId)));
  if (!read.ok) fail(`could not read the mapping from Dinora: ${read.issues.join('; ')}`);
  return read.value;
}

function decide(decisions: readonly Decision[]): number {
  if (decisions.length === 0) return 0;
  let written;
  try {
    written = readDecisionsWritten(query(decideSql(userId, decisions)));
  } catch (error) {
    fail(`the mapping was refused: ${refusalOf(error)}. Nothing of it was written.`);
  }
  if (!written.ok) fail("the mapping's answer could not be read.");
  return written.value;
}

function readMappingFile(file: string): Mapping {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(`${file} is not JSON.`);
  }
  const parsed = parseMapping(raw);
  if (!parsed.ok) fail(`${file}: ${parsed.issues.join('; ')}`);
  return parsed.value;
}

/** Nothing in the table yet: the mapping still lives in its file, and is read in once. */
function loadFromFiles(): void {
  const current = readMappingFile(mappingFile);
  if (!current.confirmed) {
    fail(
      `${mappingFile} is not confirmed yet. Read it, mark any account you do not want as\n` +
        '"skip", correct any link, set "confirmed" to true, and run this again.',
    );
  }
  // Every copy kept before a hand edit, beside the file and in the export's folder: by 28 Sep
  // 2026 they were split between Downloads and Documents.
  const copies = [...new Set([dirname(mappingFile), dir])].flatMap((folder) =>
    readdirSync(folder)
      .filter((f) => /^monarch-accounts\..+\.json$/.test(f))
      .map((f) => join(folder, f)),
  );
  const dated = (file: string): MappingCopy => ({
    file: basename(file),
    decided_at: statSync(file).mtime.toISOString(),
    mapping: readMappingFile(file),
  });
  const older = copies.map(dated);
  // The file itself is the last word, even if a copy was touched after it.
  const newestCopy = Math.max(0, ...older.map((c) => Date.parse(c.decided_at)));
  const now = dated(mappingFile);
  const last = {
    ...now,
    decided_at: new Date(Math.max(Date.parse(now.decided_at), newestCopy + 1)).toISOString(),
  };
  const written = decide(replay([...older, last]));
  console.log(
    `Kept the mapping in Dinora: ${written} decision(s) from ${mappingFile}` +
      (older.length === 1 ? ' and the older copy beside it' : '') +
      (older.length > 1 ? ` and the ${older.length} older copies beside it` : '') +
      '.\nThe files are no longer read. Check the mapping with --show before deleting them.\n',
  );
}

function show(decisions: readonly Decision[]): void {
  console.table(
    decisions.map((d) => ({
      monarch: d.monarch_name,
      goes:
        d.goes === 'link'
          ? `→ ${d.link_is ?? d.link}`
          : d.goes === 'asset'
            ? `asset: ${d.asset_kind}`
            : d.goes,
      from: d.decided_at.slice(0, 10),
      why: d.why,
    })),
  );
}

let decisions = readDecided();
if (decisions.length === 0) {
  if (existsSync(mappingFile)) {
    loadFromFiles();
    decisions = readDecided();
  } else {
    const { transactions, balances } = readExport();
    const dinora = readAccounts(query(accountsSql(userId)));
    if (!dinora.ok) fail(`could not read Dinora's accounts: ${dinora.issues.join('; ')}`);
    const names = [...new Set([...transactions, ...balances].map((r) => r.account))];
    const proposal = proposeMapping(names, dinora.value);
    writeFileSync(mappingFile, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
    const unknown = strangers(names, dinora.value);
    describeMapping(proposal, new Map(unknown.map((n) => [n, 'no Dinora account has its digits'])));
    if (unknown.length > 0) {
      console.log(
        `\n${unknown.length} account(s) end in four digits no Dinora account has. If a bank\n` +
          'reads them, this database has not pulled them yet, and they would come in as\n' +
          "history beside the bank's own. Run the nightly pull, delete the proposal, and\n" +
          'run this again.',
      );
    }
    console.log(
      `\nProposed in ${mappingFile}. Read it, mark any account you do not want as "skip",\n` +
        'correct any link, set "confirmed" to true, and run this again. That run keeps it in\n' +
        'Dinora, and the file is not read after it.',
    );
    process.exit(0);
  }
} else if (existsSync(mappingFile) && !process.argv.includes('--show')) {
  console.log(`${mappingFile} is no longer read: the mapping is kept in Dinora (--show).\n`);
}

const mapped = mappingOf(decisions);
if (!mapped.ok) fail(`the mapping in Dinora has a decision for ${mapped.bad} it cannot read.`);
const original = mapped.mapping;

if (process.argv.includes('--show')) {
  show(decisions);
  describeMapping(original);
  process.exit(0);
}

if (setName !== undefined) {
  const why = flag('--why') ?? '';
  const as = flag('--as') ?? '';
  let target = readTarget(as);
  if (target === null) {
    fail('--as takes history, skip, asset:home, asset:vehicle, asset:valuables or link:<id>.');
  }
  if (why.trim() === '') fail('--set takes --why: a decision says why it was made.');
  if (typeof target === 'object' && 'link' in target) {
    const link = target.link;
    const dinora = readAccounts(query(accountsSql(userId)));
    if (!dinora.ok) fail(`could not read Dinora's accounts: ${dinora.issues.join('; ')}`);
    const bank = dinora.value.find((a) => a.source_id === link);
    if (bank === undefined) fail(`no bank account in Dinora is ${link}.`);
    target = { link, is: `${bank.institution} · ${bank.name}` };
  }
  const before = original.accounts[setName];
  if (before !== undefined && sameTarget(before, target)) {
    console.log(`${setName} already goes there. Nothing was written.`);
    process.exit(0);
  }
  decide([decisionOf(setName, target, why.trim(), new Date().toISOString())]);
  describeMapping({ confirmed: true, accounts: { [setName]: target } });
  console.log('Kept in Dinora. Run this again without --set to import with it.');
  process.exit(0);
}

const { transactions, balances } = readExport();

/** The mapping this run imports with: Dinora's, or Dinora's with `--link` applied. */
let using: Mapping = original;
/** The Monarch name `--link` links, once the database agrees the two accounts exist. */
let linkedName: string | null = null;
if (linkFrom !== undefined && linkTo !== undefined) {
  let sql: string;
  try {
    sql = linkAccountsSql(userId, [linkFrom, linkTo]);
  } catch {
    fail('--link and --to each take an account id, as the home screen shows it.');
  }
  const pair = readLinkAccounts(query(sql));
  if (!pair.ok) fail(`could not read the two accounts: ${pair.issues.join('; ')}`);
  const linked = linkPair(original, pair.value, linkFrom, linkTo);
  if (!linked.ok) fail(`not linked: ${linked.reason}.`);
  using = linked.mapping;
  linkedName = pair.value.find((a) => a.id === linkFrom)?.source_id ?? null;
}

function saveLink(): void {
  const target = linkedName === null ? undefined : using.accounts[linkedName];
  if (linkedName === null || target === undefined) return;
  decide([
    decisionOf(
      linkedName,
      target,
      'counted twice on the home screen, put together with --link (BANK-15)',
      new Date().toISOString(),
    ),
  ]);
  console.log(`Linked ${linkedName}, and kept the link in Dinora.`);
}

const planned = plan(using, transactions, balances);
if (!planned.ok) {
  describeMapping(using);
  fail(`${planned.reason}. Say where with --set, --as and --why.`);
}
for (const s of planned.skipped) console.log(`  skipped ${s}`);

// Everything the store would refuse, before any account is written (ACCT-07).
const unready = readUnready(
  query(
    unreadySql(
      userId,
      planned.payloads.flatMap((p) => p.accounts),
    ),
  ),
);
if (!unready.ok) fail(`could not check the mapping against Dinora: ${unready.issues.join('; ')}`);
if (unready.value.length > 0) {
  fail(
    `nothing was written, since the store would refuse:\n` +
      unready.value.map((u) => `  ${describeUnready(u)}`).join('\n') +
      '\n(each is changed with --set, --as and --why; --show has them all)',
  );
}

let totals = NOTHING_STORED;
const report = [];
for (const payload of planned.payloads) {
  const name = payload.accounts[0]?.monarch_name ?? '';
  let stored: Stored | null;
  try {
    stored = readStored(query(storeSql(userId, payload)));
  } catch (error) {
    fail(
      `the store refused ${name}: ${refusalOf(error)}\n` +
        `Nothing of it was written; the ${report.length} account(s) before it were.`,
    );
  }
  if (stored === null) fail(`the store's answer for ${name} could not be read.`);
  totals = addStored(totals, stored);
  if (name === linkedName) saveLink();
  report.push({
    account: name,
    'tx new': stored.transactions_added,
    'tx changed': stored.transactions_changed,
    'tx bank has': stored.transactions_left_to_bank,
    'days new': stored.days_added,
    'days changed': stored.days_changed,
    'days bank has': stored.days_left_to_bank,
    agree: stored.days_matched,
    differ: stored.days_differed,
  });
}

const assetReport = [];
let valuesAdded = 0;
for (const asset of planned.assets) {
  let stored;
  try {
    stored = readAssetStored(query(assetSql(userId, asset)));
  } catch (error) {
    fail(
      `the asset ${asset.monarch_name} was refused: ${refusalOf(error)}\n` +
        'Nothing of it was written; every account was.',
    );
  }
  if (stored === null) fail(`the answer for the asset ${asset.monarch_name} could not be read.`);
  valuesAdded += stored.values_added;
  assetReport.push({
    asset: asset.monarch_name,
    kind: asset.kind,
    made: stored.added ? 'new' : stored.removed ? 'removed in Dinora, left out' : 'already there',
    'values in file': asset.values.length,
    'values new': stored.values_added,
  });
}

console.log('');
console.table(report);
if (assetReport.length > 0) console.table(assetReport);
console.log(
  `\n${planned.payloads.length} account(s): ${totals.accounts_added} added as history only; ` +
    `${totals.transactions_added} transaction(s) new, ${totals.transactions_changed} changed; ` +
    `${totals.days_added} day(s) new, ${totals.days_changed} changed. ` +
    `Where Dinora already has a day, Monarch's balance agreed on ${totals.days_matched} ` +
    `and differed on ${totals.days_differed}.`,
);
if (assetReport.length > 0) {
  console.log(`${assetReport.length} asset(s): ${valuesAdded} value(s) new.`);
}
if (wroteNothing(totals) && valuesAdded === 0 && !assetReport.some((a) => a.made === 'new'))
  console.log('Wrote nothing: these files were already imported.');
