/**
 * What the two deploy checks decide, apart from how they ask. The scripts beside this do
 * the fetching and the exiting; this is the part worth testing, and it is tested
 * (verdicts.test.ts) because each check exists to stop one specific way a deploy has
 * already gone wrong, and a check that quietly passes is worse than none.
 *
 * Both fail closed. An answer this code does not recognise is a refusal, never a pass.
 */

export type Verdict = { readonly ok: boolean; readonly message: string };

/** The leading version of each migration filename: `20260924000100_things.sql`. */
export function migrationVersions(filenames: readonly string[]): string[] {
  return filenames
    .filter((name) => name.endsWith('.sql'))
    .flatMap((name) => /^(\d+)_/.exec(name)?.[1] ?? [])
    .sort();
}

/**
 * Whether production has every migration this build was written against.
 *
 * `applied` is what `public.schema_version()` returned — the newest version in the
 * migration ledger. Versions are fixed-width digit strings, so they compare as strings.
 */
export function schemaVerdict(repo: readonly string[], applied: unknown): Verdict {
  const newest = repo.at(-1);
  if (newest === undefined) {
    return { ok: false, message: 'No migrations found in supabase/migrations.' };
  }
  if (typeof applied !== 'string' || applied === '') {
    return {
      ok: false,
      message: 'public.schema_version() returned no version. The migration ledger looks empty.',
    };
  }

  const pending = repo.filter((version) => version > applied);
  if (pending.length > 0) {
    const s = pending.length === 1 ? '' : 's';
    return {
      ok: false,
      message:
        `This build expects ${pending.length} migration${s} production does not have.\n\n` +
        `  production is at  ${applied}\n` +
        `  this build needs  ${newest}\n\n` +
        `  ${pending.join('\n  ')}\n\n` +
        'Push the schema first, then the app:\n\n' +
        '  pnpm db:push:dry   # read what it will run\n' +
        '  pnpm db:push\n\n' +
        'Additive migrations let the running app tolerate both shapes for the minute in\n' +
        'between; that is why the order is schema first.',
    };
  }

  // A database ahead of the bundle is the safe direction: migrations are append-only and
  // additive, so it means the schema was pushed from a commit this one does not have yet.
  return {
    ok: true,
    message:
      applied > newest
        ? `schema check: production is at ${applied}, ahead of this build's ${newest} — the safe direction.`
        : `schema check: production is at ${applied}, which is what this build expects.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DASHBOARD = 'Authentication → Sign In / Providers';

/**
 * Whether a stranger can make themselves an account, read from `/auth/v1/settings`.
 *
 * Three assertions, and the second is not padding. The dashboard has two switches with
 * nearly the same name. "Allow new users to sign up" off is the lock that is wanted. The
 * email provider's own switch off is a lockout — every email sign-in fails, for everybody,
 * with `email_provider_disabled` — and a check that read only `disable_signup` would wave
 * it through. Both measured by Nora Bene against GoTrue on 19 Sep 2026, when production
 * signup turned out to have been open since the project was created: `shouldCreateUser:
 * false` in the client is a field in a request body, not a lock (SEC-3 there). The third,
 * that email is the only way in at all, was added in DIN-13.
 */
export function signupVerdict(settings: unknown): Verdict {
  if (!isRecord(settings)) {
    return { ok: false, message: '/auth/v1/settings did not return an object.' };
  }
  if (settings.disable_signup !== true) {
    return {
      ok: false,
      message:
        'Signup is OPEN. Anybody who reaches the app can make themselves an account; the\n' +
        'client refusing to is a request field, not a lock.\n\n' +
        `  ${DASHBOARD} → Allow new users to sign up → OFF\n\n` +
        'Accounts are still created on purpose — an invite or the dashboard — through the\n' +
        'admin API, which this switch does not gate.',
    };
  }
  const external = settings.external;
  if (!isRecord(external) || external.email !== true) {
    return {
      ok: false,
      message:
        'Signup is closed, but EMAIL SIGN-IN IS ALSO OFF, so nobody can sign in at all —\n' +
        'not a stranger, not you. That is the neighbouring switch, and it is a lockout.\n\n' +
        `  ${DASHBOARD} → Email → Enable email provider → ON\n` +
        `  ${DASHBOARD} → Allow new users to sign up    → OFF  (this one stays off)`,
    };
  }
  // DIN-13: an anonymous sign-in makes a second `authenticated` user, and `owner()`
  // (api/_lib/nightly.ts) answers 503 to every function once there are two — a denial of
  // service, not a read. Kept apart from the rest because it is the one with a known cost.
  if (external.anonymous_users !== false) {
    return {
      ok: false,
      message:
        'ANONYMOUS SIGN-INS ARE ON (or unreadable). Each one makes a real authenticated user,\n' +
        'and with two users every function refuses to guess whose rows to read.\n\n' +
        `  ${DASHBOARD} → Allow anonymous sign-ins → OFF`,
    };
  }
  // An allow-list, not a list of OAuth names: email is the one way in, and anything else
  // that is not exactly `false` refuses — so a provider GoTrue adds later is refused until
  // somebody has looked at it. Production had only email on when this was written
  // (14 Oct 2026); passkeys sit outside `external` and only sign in an existing user.
  const others = Object.entries(external)
    .filter(([name, on]) => name !== 'email' && on !== false)
    .map(([name]) => name);
  if (settings.saml_enabled !== false) others.push('saml_enabled');
  if (others.length > 0) {
    return {
      ok: false,
      message:
        'Signup is closed, but ANOTHER WAY IN IS ON (or unreadable). Email is the only one\n' +
        'Dinora uses; every other provider is a door nobody is watching.\n\n' +
        `  ${others.join('\n  ')}\n\n` +
        `  ${DASHBOARD} → each of these → OFF  (SAML is turned off with the CLI's sso commands)`,
    };
  }
  return {
    ok: true,
    message: 'signup check: closed to strangers, email is the only way in, and it still works.',
  };
}
