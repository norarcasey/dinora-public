/**
 * A lender's statement into Dinora (ACCT-20), from a CSV on this laptop.
 *
 *   pnpm statement:import --account <id> --file <csv> [--email one@example.test]
 *                                     this checkout's local stack
 *   pnpm statement:import --production --account <id> --file <csv>
 *                                     the linked hosted project, from the main checkout only
 *
 * `--account` is Dinora's id for the loan; the file is `readStatement`'s. It fills only the
 * days before anything else Dinora holds for the account, and a second run with the same file
 * writes nothing. The file stays beside the lender's PDF, outside the repo.
 *
 * What it prints is counts and dates: never an amount (invariant 4).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { parse } from '../../packages/core/src/parse.ts';
import { readStatement } from '../../packages/core/src/statement.ts';
import { expandHome, flag } from '../argv.ts';
import { stack } from '../db/stack.ts';
import { findAnswer, literal, readUserIds, userSql } from '../monarch/sql.ts';
import type { Query } from '../monarch/steps.ts';
import { isWorktree } from '../monarch/steps.ts';

function fail(message: string): never {
  console.error(`statement: ${message}`);
  process.exit(1);
}

const production = process.argv.includes('--production');
const accountFlag = flag(process.argv, '--account');
if (!accountFlag.ok) fail(accountFlag.reason);
const account = parse(z.guid(), accountFlag.value);
if (!account.ok) fail('--account takes the loan account’s id in Dinora.');
const fileFlag = flag(process.argv, '--file');
if (!fileFlag.ok) fail(fileFlag.reason);
if (fileFlag.value === undefined) fail('--file takes the CSV to read.');
const file = expandHome(fileFlag.value);
const emailFlag = flag(process.argv, '--email');
if (!emailFlag.ok) fail(emailFlag.reason);

async function target(): Promise<Query> {
  if (production) {
    if (isWorktree(process.cwd()))
      fail('--production runs from the main checkout, after the branch merges.');
    return (sql) => {
      // A file rather than an argument, since argv lands in `ps`.
      const scratch = mkdtempSync(join(tmpdir(), 'statement-'));
      const path = join(scratch, 'query.sql');
      writeFileSync(path, sql, { mode: 0o600 });
      try {
        return execFileSync(
          'npx',
          ['supabase', 'db', 'query', '--linked', '--output-format', 'json', '-f', path],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    };
  }
  const s = await stack(process.cwd(), false);
  return (sql) =>
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        `supabase_db_${s.projectId}`,
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
      { input: sql, encoding: 'utf8', stdio: 'pipe' },
    );
}

const statement = readStatement(readFileSync(file, 'utf8'));
if (!statement.ok) fail(`${file}: ${statement.reason}`);
const first = statement.days[0]?.on_date;
const last = statement.days.at(-1)?.on_date;
console.log(
  `${file}: ${statement.entries} entries, the chain checks, ${statement.days.length} days from ${first} to ${last}`,
);

const query = await target();
const users = readUserIds(
  query(userSql(production ? null : (emailFlag.value ?? 'one@example.test'))),
);
if (!users.ok || users.value.length !== 1) {
  fail(
    production
      ? 'production does not have exactly one user, so whose rows these are is not known.'
      : "no such user in this checkout's local database.",
  );
}
const [userId] = users.value;
if (userId === undefined) fail('no user.');

let output: string;
try {
  output = query(`begin;
set local role service_role;
select json_build_object('stored', public.statement_store('${userId}'::uuid, '${account.value}'::uuid, ${literal(JSON.stringify(statement.days))}::jsonb)) as answer;
commit;
`);
} catch (error) {
  // Only Postgres's own line: its DETAIL could quote a figure (invariant 4).
  const text = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
  fail(
    /statement_store: [^"\\\n]*/.exec(text)?.[0] ?? 'the store refused, and said nothing readable.',
  );
}
const stored = parse(
  z.object({
    days_added: z.int(),
    days_changed: z.int(),
    days_left_to_others: z.int(),
    fills_before: z.iso.date(),
  }),
  findAnswer(output, 'stored'),
);
if (!stored.ok) fail('the store answered in a shape this does not read.');
const s = stored.value;
console.log(
  s.days_added + s.days_changed === 0
    ? `Wrote nothing: this statement was already imported. It fills before ${s.fills_before}.`
    : `Wrote ${s.days_added} new days and changed ${s.days_changed}, all before ${s.fills_before}; ${s.days_left_to_others} days were left to Dinora's own history.`,
);
