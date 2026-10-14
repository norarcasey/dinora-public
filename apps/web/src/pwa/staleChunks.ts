import { BUILD } from '../build.ts';

/**
 * What the app does when it asks for a chunk that is no longer on the server.
 *
 * Ordinary, not a bug: a phone that has had the app in its switcher since yesterday is
 * running yesterday's build. A deploy lands, the new service worker takes over on the spot
 * and throws the old precache away, and nothing on screen changes — until a lazy route asks
 * for a hashed file that neither the cache nor the host has any more. The repair is to
 * reload. The rest of this file is the two ways that goes wrong, both from Nora Bene.
 *
 * **It must not loop.** A route lives in the URL, so a reload that does not fix anything asks
 * for the same missing chunk on the way back up. So it is one attempt *per build*: the id is
 * written down before the reload, and a build that finds its own id there has already tried.
 * A reload that worked comes back as a different build and is armed again.
 *
 * **It must not swallow the error.** `vite:preloadError` is cancelable, and cancelling it
 * makes Vite resolve the import with `undefined` — so the clean failure reaches the error
 * boundary as a TypeError about reading a property of nothing. This listens and does not
 * cancel: if the reload has not landed by the time the import settles, the boundary does
 * what it always did.
 *
 * What a reload costs is anything typed and not yet saved — the same text iOS takes when it
 * evicts a backgrounded app.
 */

/**
 * Survives the reload it guards and has no business outliving the tab, so sessionStorage.
 * Also what stops a second reload within one page: one failed import dispatches the event
 * once per preload link and again for the module, and `reload()` returns immediately.
 */
const RELOADED_FOR = 'dinora.stale-chunk-reload';

/** `reload` is a seam: jsdom's `location.reload` cannot be replaced. Returns a teardown. */
export function watchForStaleChunks(
  target: Window = window,
  reload: () => void = () => target.location.reload(),
): () => void {
  const onPreloadError = (): void => {
    if (arm(target)) reload();
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => target.removeEventListener('vite:preloadError', onPreloadError);
}

/** Whether this build still has its one attempt, and takes it. */
function arm(target: Window): boolean {
  try {
    if (target.sessionStorage.getItem(RELOADED_FOR) === BUILD) return false;
    target.sessionStorage.setItem(RELOADED_FOR, BUILD);
    return true;
  } catch {
    // Storage refused. A reload that cannot record that it happened could loop, and a
    // reloading app is worse than one broken route.
    return false;
  }
}
