/**
 * Why a write failed, in words the screen can show (OPS-04).
 *
 * Every save and removal used to say *Not saved. Try again when Dinora can be reached.*,
 * whatever happened. On 25 Sep 2026 a save failed in DuckDuckGo that Chrome then made at
 * once, so Dinora had been reached, and nothing said what had refused it. Two failures read
 * the same and need different answers: the request never arrived, or the server said no.
 *
 * PostgREST's code is what tells them apart and what is shown. It names a rule (`42501`, not
 * allowed; `23514`, a check), never a value, so it can sit on screen and in a report without
 * quoting a row (invariant 4). The message and details can quote one, and are never kept.
 */

export class WriteError extends Error {
  /** PostgREST's or Postgres's code. Empty when the request got no answer. */
  readonly code: string;

  constructor(what: string, code: string) {
    super(`${what}: ${code === '' ? 'no answer' : code}`);
    this.name = 'WriteError';
    this.code = code;
  }
}

/**
 * A supabase-js error as a WriteError, keeping only its code. An answer that is not
 * PostgREST's own (a proxy's, or a blocker's) carries no code, and its HTTP status stands in;
 * no answer at all is status 0 and an empty code.
 */
export function writeFailed(
  what: string,
  error: { readonly code?: string | undefined },
  status: number,
): WriteError {
  const code = error.code ?? '';
  return new WriteError(what, code !== '' ? code : status > 0 ? `HTTP ${status}` : '');
}

/** What the screen says for a failed save or removal. */
export function notDone(error: unknown, done: 'saved' | 'removed'): string {
  const failed = done === 'saved' ? 'Not saved' : 'Not removed';
  if (error instanceof WriteError && error.code !== '') {
    return `${failed}: Dinora refused it (code ${error.code}).`;
  }
  return `${failed}. Try again when Dinora can be reached.`;
}
