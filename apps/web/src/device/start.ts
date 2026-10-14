import type { QueryClient } from '@tanstack/react-query';

import { auth } from '../supabase/client.ts';
import { readStoredSession, rememberedUser } from '../supabase/remembered.ts';
import type { CacheableTable } from './cache.ts';
import { ownCache, restoreCache, watchCache } from './cache.ts';

/**
 * Puts this device's rows back and keeps them honest. Called once from main.tsx, before
 * React mounts, so the disk read is in flight during the first render.
 *
 * Keyed on the session already in localStorage — the same answer `useSession` renders from —
 * so the screen and the store cannot disagree about who is here.
 */
export function startOfflineRead(client: QueryClient, tables: readonly CacheableTable[]): void {
  restoreCache(client, rememberedUser(readStoredSession())?.id ?? null, tables);
  watchCache(client, tables);
  auth.onAuthStateChange((event, session) => {
    // See `ownCache`: the initial event cannot tell signed out from unreachable.
    if (event === 'INITIAL_SESSION') return;
    void ownCache(client, session?.user.id ?? null);
  });
}
