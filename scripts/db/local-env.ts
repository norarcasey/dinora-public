/**
 * Points the web app at the local stack: writes apps/web/.env.local from `supabase status`.
 *
 *   pnpm db:start && pnpm db:env
 *
 * The file is gitignored, and holds only the two public values the browser gets anyway.
 * Rewritten rather than edited, because the only thing it is for is this. In a worktree it is
 * that worktree's stack, which is why .worktreeinclude does not copy the main checkout's.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stack, supabaseOutput } from './stack.ts';

const s = await stack(process.cwd(), false);
let status: string;
try {
  status = supabaseOutput(s, ['status', '-o', 'env']);
} catch {
  console.error('The local stack is not running. Start it with `pnpm db:start`.');
  process.exit(1);
}

const values = new Map<string, string>();
for (const line of status.split('\n')) {
  const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
  if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
}

// PUBLISHABLE_KEY since the CLI's move to sb_publishable_ keys; ANON_KEY is the old JWT,
// still printed and still accepted, read only if the new one is missing.
const url = values.get('API_URL');
const key = values.get('PUBLISHABLE_KEY') ?? values.get('ANON_KEY');
if (!url || !key) {
  console.error('`supabase status` printed no API_URL or key. Is the stack fully started?');
  process.exit(1);
}

const target = join(s.root, 'apps', 'web', '.env.local');
writeFileSync(target, `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${key}\n`);
console.log(`Wrote apps/web/.env.local for ${url}.`);
