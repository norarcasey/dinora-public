import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a request is Vercel Cron calling, rather than anyone who found the path.
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` when the project has a CRON_SECRET
 * variable. Without one set this refuses everything: a scheduled job that anybody can
 * trigger by URL is a job somebody will, and a missing secret must not read as "no check".
 *
 * Shared from `api/_lib/` — a path starting with `_` is not deployed as a function — and
 * imported with a `.ts` specifier like everything else, which works in a deployed function
 * only because the root tsconfig sets `rewriteRelativeImportExtensions`.
 *
 * What the cron itself must be, from Vercel's docs as read on 24 Sep 2026: delivery is
 * best effort — a run can be missed and a run can arrive twice — and a failed run is not
 * retried. On Hobby a job runs at most once a day, somewhere inside the hour it names. So
 * a job is written to reconcile ("everything since the last run that succeeded"), never to
 * increment, and records its own last success where the app can show it.
 */
export function isCronRequest(request: Request, secret: string | undefined): boolean {
  if (secret === undefined || secret.length < 16) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
