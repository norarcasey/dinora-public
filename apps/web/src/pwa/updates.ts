import { useSyncExternalStore } from 'react';

/**
 * Noticing a deploy while the app is open (OPS-04), and saying so.
 *
 * A browser looks for a new service worker when a page is navigated to, and Dinora is one page
 * whose routes are hashes: it never navigates. So a tab or an installed app left open kept the
 * build it opened with until it was closed. The first reload after a deploy was answered from
 * the old worker's cache, and only a second one showed the new build. Chrome looks eagerly
 * enough to hide that. DuckDuckGo on the Mac, Safari's engine underneath, did not: on 25 Sep
 * 2026 Nora refreshed both after a deploy and only Chrome changed. The same day a save that
 * Chrome made failed in DuckDuckGo with nothing on screen to say why, which is the other half
 * of OPS-04 (`queries/writes.ts`).
 *
 * So the app asks for itself: when it comes back into view and every half hour while it is
 * seen. `sw.js` is served `max-age=0, must-revalidate` (vercel.json), so each ask is one
 * conditional request, answered 304 until something ships.
 *
 * When a new worker takes over (`skipWaiting` and `clientsClaim`, in pwa.config.ts), the page
 * running is the old build. It says so and offers a reload, and never reloads by itself. The
 * natural moment for that would be while the app is hidden, which is exactly when she has
 * switched away to copy a VIN into a half-filled form.
 */

/** Reasoned, not measured: a deploy a day at most, and a 304 costs nothing. */
export const CHECK_EVERY_MS = 30 * 60 * 1000;

let ready = false;
const listeners = new Set<() => void>();

function announce(): void {
  ready = true;
  for (const listener of listeners) listener();
}

/** Whether a newer build than the one running has taken over this page. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ready,
    () => false,
  );
}

/** For tests: back to the build the page opened with. */
export function forgetUpdate(): void {
  ready = false;
}

/** Returns a teardown. Does nothing where there is no service worker: jsdom, or a Mac WebView without one. */
export function watchForUpdates(target: Window = window): () => void {
  const container: ServiceWorkerContainer | undefined = target.navigator.serviceWorker;
  if (container === undefined) return () => {};

  // The first worker to install also takes control, by `clientsClaim`. That is this build's
  // own worker arriving, not a newer build.
  let controlled = container.controller !== null;
  const onControllerChange = (): void => {
    if (controlled) announce();
    controlled = true;
  };

  const check = (): void => {
    container
      .getRegistration()
      .then((registration) => registration?.update())
      // Offline, or the worker file answered badly: the next check tries again.
      .catch(() => {});
  };
  const onVisibility = (): void => {
    if (target.document.visibilityState === 'visible') check();
  };
  const timer = target.setInterval(() => {
    if (target.document.visibilityState === 'visible') check();
  }, CHECK_EVERY_MS);

  container.addEventListener('controllerchange', onControllerChange);
  target.document.addEventListener('visibilitychange', onVisibility);
  return () => {
    container.removeEventListener('controllerchange', onControllerChange);
    target.document.removeEventListener('visibilitychange', onVisibility);
    target.clearInterval(timer);
  };
}
