import { minimal2023Preset } from '@vite-pwa/assets-generator/config';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * What makes the app installable, and what the service worker is allowed to do.
 *
 * Here rather than inline in vite.config.ts so the reasons travel with the settings: every
 * line below is one Nora Bene paid for, and a config that loses its comments gets "tidied"
 * back into the bug.
 */

/**
 * The app's colours in the install banner, the splash screen and the status bar: Azulejo's
 * porcelain, `--bg` in `src/app.css` (UI-06). A manifest has one of each, so these are the
 * light ones; index.html gives the dark theme colour to the browsers that read a media query.
 */
const THEME_COLOUR = '#eef2f7';
const BACKGROUND_COLOUR = '#eef2f7';

/**
 * The cobalt tile of `public/favicon.svg`. The preset pads the maskable and apple-touch icons
 * and fills the padding with white by default, which on a phone's home screen drew the mark
 * as a small tile on a white plate (seen in the build, 26 Sep, `UI-13`). Filled with the
 * tile's own colour the padding disappears into it; the apple icon also drops its padding,
 * because iOS rounds the corners itself and a mark shrunk inside that looks like a mistake.
 */
const TILE_COLOUR = '#2341a8';

/**
 * Which build this is, as `import.meta.env.VITE_BUILD`. Read through `src/build.ts`.
 *
 * The stale-chunk guard needs it to know whether this build has already spent its one reload,
 * and anything that reports a failure wants it for the first question about any crash: is it
 * still there. Vercel supplies the commit on a Vercel build and Actions in CI; a local build
 * says `dev`. Seven characters, because a person reads it and matches it against `git log`.
 */
function buildId(): Plugin {
  const id = (process.env['VERCEL_GIT_COMMIT_SHA'] ?? process.env['GITHUB_SHA'] ?? 'dev').slice(
    0,
    7,
  );
  return {
    name: 'build-id',
    config: () => ({ define: { 'import.meta.env.VITE_BUILD': JSON.stringify(id) } }),
  };
}

export function pwa(): Plugin[] {
  return [
    buildId(),
    ...VitePWA({
      // The new worker takes over as soon as it installs, and the page is not reloaded under
      // somebody's hands. What that costs — a running page whose lazy chunks are gone — is
      // what `src/pwa/staleChunks.ts` repairs.
      registerType: 'autoUpdate',
      manifest: {
        name: 'Dinora',
        short_name: 'Dinora',
        description:
          'Every account in one place, read-only: balances, budgets, goals, projections and history.',
        // Relative, never an origin: moving host is then a DNS change, not a grep.
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: THEME_COLOUR,
        background_color: BACKGROUND_COLOUR,
      },
      /*
        Icons are generated at build time from `public/favicon.svg` — the 64, 192 and 512 the
        manifest lists, a maskable 512 and the 180 apple-touch-icon iOS reads instead of the
        manifest — and linked from index.html along with the theme colour. Nothing rasterised
        is committed, so replacing the mark is replacing one file.
      */
      pwaAssets: {
        overrideManifestIcons: true,
        preset: {
          ...minimal2023Preset,
          maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: TILE_COLOUR } },
          apple: {
            ...minimal2023Preset.apple,
            padding: 0,
            resizeOptions: { background: TILE_COLOUR },
          },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // The shell must open with no signal, or nothing else offline matters.
        navigateFallback: '/index.html',
        /*
          Except under /api/, which is a Vercel function on this same origin. The fallback
          answers navigations, and a navigation there is real: a sign-in or bank-consent
          callback redirects the browser to `/api/<something>?code=…`. Answered from the
          precache, the function never runs and the page is the app's home screen. Nora Bene
          had a denylist that could never match — its API was on another origin — and it was
          right to remove it; this one matches the one path that is here.
        */
        navigateFallbackDenylist: [/^\/api\//],
        /*
          Nothing is cached at runtime, and this empty array is what says so. Workbox handles
          a request only if a route claims it, so with none every data request goes to the
          network or fails — a stale answer from the service worker is never mistaken for the
          server's. The app's own offline reads, if it has them, are rows it chose to keep, in
          IndexedDB, under an owner (the `offline-read` layer). The first entry added here
          switches that guarantee off; add it knowing so.
        */
        runtimeCaching: [],
      },
      // Off in dev: a service worker caching the dev server makes every edit a guess. The
      // worker is checked against `pnpm build && pnpm preview`.
      devOptions: { enabled: false },
    }),
  ];
}
