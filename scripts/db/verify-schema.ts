/**
 * Runs the schema invariants.
 *
 *   pnpm db:verify           the local stack: structural, then behavioural
 *   pnpm db:verify:remote    SUPABASE_DB_URL: structural only
 *
 * psql runs inside a container, so no Postgres client is needed on the host: the local
 * stack's own database container, or a throwaway postgres image for a remote. The
 * behavioural file switches roles and writes rows and relies on the seeded users, so it
 * never runs against a real project; the structural one is catalogue queries in a READ
 * ONLY transaction and is safe anywhere — which is the point: "RLS is on in production" is
 * worth knowing rather than assuming. The hosted platform's default grants differ from the
 * local image's, and only a remote run sees that.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { stack } from './stack.ts';

const remote = process.argv.includes('--remote');
const root = new URL('../../', import.meta.url);
const structural = new URL('supabase/tests/schema_invariants.sql', root);
const behavioural = new URL('supabase/tests/rls_behaviour.sql', root);

function fail(message: string): never {
  console.error(`\nschema invariants: ${message}`);
  process.exit(1);
}

/**
 * The local database container is named after the stack's project id — config.toml's in the
 * main checkout, the worktree's own in a worktree — so it is resolved, not assumed.
 */
const localContainer = remote ? '' : `supabase_db_${(await stack(process.cwd(), false)).projectId}`;

/**
 * The behavioural file, wrapped in a transaction that is always rolled back.
 *
 * The refusal is the load-bearing half: wrapping alone is undone the first time somebody
 * writes `commit;` in the file. Column zero and a semicolon, both deliberate — PL/pgSQL
 * opens a block with a bare `begin` and closes it with `end;`, so a looser pattern flags
 * every `do $$` in the file, as Nora Bene's did on its first run.
 */
function wrapped(sql: string): string {
  const stray = /^(begin|start\s+transaction|commit|rollback)\s*;/im.exec(sql);
  if (stray !== null) {
    fail(
      `rls_behaviour.sql contains its own transaction control (${stray[0].trim()}).\n` +
        'The run wraps it in a transaction that is always rolled back; a begin, commit or\n' +
        'rollback inside ends that wrapper, and everything after it commits.',
    );
  }
  return `begin;\n${sql}\nrollback;\n`;
}

function psqlArgs(): string[] {
  if (!remote) {
    return [
      'exec',
      '-i',
      localContainer,
      'sh',
      '-c',
      'psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q 2>&1',
    ];
  }
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    fail(
      'SUPABASE_DB_URL is not set. Use the session pooler connection string —\n' +
        '  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n' +
        'The direct db.<ref>.supabase.co host is IPv6-only and does not resolve on most networks.',
    );
  }
  return [
    'run',
    '--rm',
    '-i',
    '-e',
    `SUPABASE_DB_URL=${url}`,
    'postgres:17-alpine',
    'sh',
    '-c',
    'psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q 2>&1',
  ];
}

const inputs = [readFileSync(structural, 'utf8')];
if (!remote) inputs.push(wrapped(readFileSync(behavioural, 'utf8')));

let output = '';
try {
  for (const input of inputs) {
    // psql sends NOTICE to stderr and the PASS lines are notices, so the container merges
    // stderr into stdout rather than losing them.
    output += execFileSync('docker', psqlArgs(), { input, encoding: 'utf8' });
  }
} catch (error) {
  const partial =
    error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'
      ? error.stdout
      : '';
  process.stdout.write(output + partial);
  // A failed invariant and a database never reached are different problems, and
  // suggesting `db:start` for the first sends you looking in the wrong place.
  fail(
    /ERROR|FATAL/.test(partial)
      ? 'FAILED. See the ERROR above.'
      : remote
        ? 'could not run against the remote project. Check SUPABASE_DB_URL and Docker.'
        : 'could not run. Is the local stack up? (pnpm db:start)',
  );
}

process.stdout.write(output);
if (/ERROR|FATAL/.test(output)) fail('FAILED. See the ERROR above.');
console.log(`schema invariants: all checks passed${remote ? ' (structural, remote)' : ''}.`);
