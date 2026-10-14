/**
 * The Supabase CLI, pointed at this checkout's own local stack. Every `db:*` script that
 * talks to a stack goes through here, so the main checkout and each worktree reach their own
 * and never each other's (see stack.ts for why that needs saying).
 *
 *   pnpm db:start | db:stop | db:reset | db:new <name> | db:push:dry | db:push
 *
 * Two refusals, both only in a worktree. `db push`, dry or not, is for production, which gets
 * a migration from `main` after the branch has merged, not from a branch still being worked
 * on. And `stop` there takes `--no-backup`: a worktree's database is rebuilt from migrations
 * by `db:reset`, and a kept volume would be picked up by a later worktree of the same name.
 */
import { findOrphans, stack, supabase } from './stack.ts';

const args = process.argv.slice(2);
const command = args[0];
if (command === undefined) {
  console.error('usage: supabase.ts <supabase CLI arguments>');
  process.exit(2);
}

const pushing = command === 'db' && args[1] === 'push';
const s = await stack(process.cwd(), command === 'start');

// The dry run too, though it writes nothing: a worktree's SUPABASE_PROJECT_ID override is
// read by the CLI as the linked project's ref, so there it can only fail with "Invalid
// project ref format" (measured 24 Sep 2026, BANK-01) — which reads like a broken link.
if (s.worktree && pushing) {
  console.error(
    'Refusing `db push` from a worktree, the dry run included. Production gets its migrations\n' +
      'from main: merge this branch, then run `pnpm db:push:dry` and `pnpm db:push` from the\n' +
      'main checkout.',
  );
  process.exit(1);
}

if (s.worktree) {
  console.log(`Worktree stack ${s.projectId}: API ${s.ports.api}, database ${s.ports.db}.`);
}
const status = supabase(s, command === 'stop' && s.worktree ? [...args, '--no-backup'] : args);

if (command === 'start') {
  const left = findOrphans(s.root, s.appId);
  if (left === null) {
    console.log('(Could not ask Docker for stacks left behind by removed worktrees.)');
  } else if (left.length > 0) {
    console.log(
      `\n${left.length} stack(s) belong to worktrees that no longer exist, about 480 MiB each: ` +
        `${left.join(', ')}.\nRemove them with \`pnpm db:orphans --stop\`.`,
    );
  }
}
process.exit(status);
