/**
 * Local stacks started by worktrees that have since been removed. Claude Code removes a clean
 * worktree when its session ends, and nothing stops the stack it started, so its containers
 * keep running with no checkout left to `db:stop` them from.
 *
 *   pnpm db:orphans           list them
 *   pnpm db:orphans --stop    stop them and discard their volumes
 */
import { app, findOrphans, supabase } from './stack.ts';

const unknown = process.argv.slice(2).filter((arg) => arg !== '--stop');
if (unknown.length > 0) {
  console.error(`Unknown argument ${unknown.join(' ')} (expected --stop).`);
  process.exit(2);
}

const { root, appId } = app(process.cwd());
const left = findOrphans(root, appId);
if (left === null) {
  console.error('Could not ask Docker. Is it running?');
  process.exit(1);
}
if (left.length === 0) {
  console.log(`No stacks left behind by removed worktrees of ${appId}.`);
  process.exit(0);
}
if (!process.argv.includes('--stop')) {
  console.log(`${left.join('\n')}\n\n${left.length} left behind. \`--stop\` removes them.`);
  process.exit(0);
}
let failed = 0;
for (const id of left) {
  if (supabase({ root, env: {} }, ['stop', '--project-id', id, '--no-backup']) !== 0) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
