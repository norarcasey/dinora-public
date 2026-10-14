/**
 * Refuses to deploy while anybody can make themselves an account.
 *
 *   VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… pnpm auth:closed
 *
 * The lock is a setting on the hosted project, which nothing in the repo can set and, until
 * Nora Bene wrote this check, nothing had ever read. What it has to get right is in
 * `signupVerdict`: there are two switches, and one of them locks everyone out.
 */
import { ask, fail } from './production.ts';
import { signupVerdict } from './verdicts.ts';

const TITLE = 'Signup check failed.';
const answer = await ask(TITLE, '/auth/v1/settings');

if (answer.status !== 200) fail(TITLE, `Asking for the auth settings returned ${answer.status}.`);

const verdict = signupVerdict(answer.body);
if (!verdict.ok) fail(TITLE, verdict.message);
console.log(verdict.message);
