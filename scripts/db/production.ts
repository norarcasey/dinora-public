/**
 * Asking the hosted project a question with the two values the deploy already carries —
 * the project URL and the publishable key, both public, both in every bundle. Never a
 * database password or a service key: a deploy that could change the database is one
 * workflow edit away from doing so on a green build.
 *
 * Fails closed. A project that cannot be reached is a project whose answer is unknown,
 * and shipping into an unknown is the thing each check exists to prevent.
 */

export function fail(title: string, message: string): never {
  console.error(`\n${title}\n\n${message}\n`);
  process.exit(1);
}

export type Answer = { readonly status: number; readonly body: unknown };

export async function ask(
  title: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<Answer> {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    fail(
      title,
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set. Both are public values —\n' +
        'the project URL and its sb_publishable_ key. In the deploy job they come from the\n' +
        'repository secrets of the same names.',
    );
  }

  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(
      title,
      `Could not reach ${url}.\n  ${String(error)}\n\n` +
        'Refusing rather than deploying blind: an answer that cannot be read is not a pass.',
    );
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Left null. Every verdict reads null as "not an answer" and refuses.
  }
  return { status: response.status, body };
}
