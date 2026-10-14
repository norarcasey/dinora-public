import { useSyncExternalStore } from 'react';

/**
 * Whether the browser thinks it has a network — for switching edits off while it does not,
 * which is how an app without an outbox stays honest offline.
 *
 * A hint in one direction only. `false` is reliable: there is no interface. `true` means an
 * interface exists, not that the server answers, so a write must still handle failing.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

function snapshot(): boolean {
  return navigator.onLine;
}
