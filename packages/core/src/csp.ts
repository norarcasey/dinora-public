import { z } from 'zod';

import { parse } from './parse.ts';

/**
 * The page's Content-Security-Policy (DIN-14).
 *
 * The page holds the session token and the cached rows, so what matters is where a script
 * that got in could send them: `connect-src` names this Supabase project and nothing else.
 * Not `*.supabase.co`, which would let it post them to a project of its own.
 *
 * Measured against the build, 14 Oct 2026: no inline script (the service worker registers
 * from `/registerSW.js`), no inline style, fonts self-hosted, images our own or the `data:`
 * SVG masks in `app.css`. Plaid's Hosted Link and the bank's consent page are links that
 * leave the page, which a policy does not govern.
 *
 * Built from the Supabase URL at build time and written into index.html, because that URL is
 * a deploy secret kept out of the public copy and `vercel.json` is the same in both. A
 * `<meta>` policy cannot carry `frame-ancestors`; `X-Frame-Options: DENY` in `vercel.json`
 * does that job.
 *
 * With no URL (CI's gate builds without the deploy's secrets) the page may reach only
 * itself, which is all such a bundle could reach anyway. A URL that is not one is null, so
 * the build can refuse it rather than ship a policy that names nothing.
 */
export function contentSecurityPolicy(supabaseUrl: string | undefined): string | null {
  const origin = supabaseUrl === undefined ? null : originOf(supabaseUrl);
  if (supabaseUrl !== undefined && origin === null) return null;
  const directives: readonly (readonly [string, string])[] = [
    ['default-src', "'self'"],
    ['script-src', "'self'"],
    ['style-src', "'self'"],
    ['img-src', "'self' data:"],
    ['font-src', "'self'"],
    ['connect-src', origin === null ? "'self'" : `'self' ${origin}`],
    ['worker-src', "'self'"],
    ['manifest-src', "'self'"],
    ['frame-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join('; ');
}

const httpUrl = z.url({ protocol: /^https?$/ });

/** Scheme, host and port, lower-cased; null for anything but an http(s) URL. */
function originOf(url: string): string | null {
  const parsed = parse(httpUrl, url);
  if (!parsed.ok) return null;
  const match = /^(https?:\/\/)(?:[^@/?#]*@)?([^/?#]+)/i.exec(parsed.value);
  const scheme = match?.[1];
  const host = match?.[2];
  if (scheme === undefined || host === undefined) return null;
  return `${scheme}${host}`.toLowerCase();
}
