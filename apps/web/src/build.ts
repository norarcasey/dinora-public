/**
 * Which build this is, injected at build time by `pwa.config.ts`.
 *
 * One answer for the whole app: the stale-chunk guard keys its single reload on it, and
 * anything that reports a failure should name the same build. Under Vitest nothing injects
 * it, and it reads `dev`.
 */
const injected: unknown = import.meta.env['VITE_BUILD'];

export const BUILD: string = typeof injected === 'string' ? injected : 'dev';
