/**
 * Refuses to deploy a build whose migrations production does not have yet.
 *
 *   VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… pnpm db:deployed
 *
 * Migrations are pushed by hand (`pnpm db:push`), never by CI, so this cannot apply what
 * is missing; it can only stop a bundle going out ahead of its schema. Nora Bene's board
 * once did, and production served a build expecting a column that did not exist. The rule
 * "migration first" was written down, and was the one rule there kept by remembering.
 */
import { readdirSync } from 'node:fs';

import { ask, fail } from './production.ts';
import { migrationVersions, schemaVerdict } from './verdicts.ts';

const TITLE = 'Schema check failed.';
const repo = migrationVersions(readdirSync(new URL('../../supabase/migrations', import.meta.url)));

const answer = await ask(TITLE, '/rest/v1/rpc/schema_version', 'POST');

if (answer.status === 404) {
  fail(
    TITLE,
    'This project has no public.schema_version(), so the foundation migration has never\n' +
      'been pushed to it:\n\n' +
      '  pnpm db:push:dry\n' +
      '  pnpm db:push\n\n' +
      'Which is the ritual this check exists to enforce, arriving at its own installation.',
  );
}
if (answer.status !== 200) fail(TITLE, `Asking for the schema version returned ${answer.status}.`);

const verdict = schemaVerdict(repo, answer.body);
if (!verdict.ok) fail(TITLE, verdict.message);
console.log(verdict.message);
