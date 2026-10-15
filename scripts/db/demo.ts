/**
 * Fills the local stack with a year of invented money for one@example.test (DIN-21).
 *
 *   pnpm db:start && pnpm db:demo
 *
 * What the README's screenshots are taken from, and a way to see every page with something on
 * it. It runs `supabase/demo.sql` through psql in this checkout's own database container, the
 * one `pnpm db:start` made, and takes no URL, so there is no way to point it at a deployed
 * project. `pnpm db:reset` takes the demo away again.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { stack } from './stack.ts';

const container = `supabase_db_${(await stack(process.cwd(), false)).projectId}`;
const sql = readFileSync(new URL('../../supabase/demo.sql', import.meta.url), 'utf8');

try {
  execFileSync(
    'docker',
    ['exec', '-i', container, 'sh', '-c', 'psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q'],
    { input: sql, stdio: ['pipe', 'inherit', 'inherit'] },
  );
} catch {
  console.error(
    `\nThe demo was not loaded into ${container}. If the stack is not running, start it with ` +
      '`pnpm db:start`.',
  );
  process.exit(1);
}

console.log('Loaded the demo. Sign in locally as one@example.test; the code is in Mailpit.');
