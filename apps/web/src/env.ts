import { parse } from '@dinora/core/parse';
import { z } from 'zod';

/**
 * The two values the browser needs to reach Supabase, parsed at the boundary like any
 * other untyped input. Both are public: the project URL and its publishable key.
 *
 * Locally they come from apps/web/.env.local, which `pnpm db:env` writes from the running
 * stack. In production the deploy job sets them from repository secrets at build time —
 * as process env rather than through `vercel pull`, which pulls a variable marked
 * sensitive as the literal string "[SENSITIVE]"; that once shipped a Nora Bene bundle
 * that could not reach its database at all.
 */
const schema = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
});

const parsed = parse(schema, import.meta.env);
if (!parsed.ok) {
  // Names only, never values: a misplaced secret in one of these would end up in a log.
  throw new Error(
    `Supabase is not configured: ${parsed.issues.map((i) => i.split(':')[0]).join(', ')}`,
  );
}

export const env = parsed.value;
