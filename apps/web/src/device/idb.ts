import type { DBSchema, IDBPDatabase, OpenDBCallbacks } from 'idb';
import { openDB } from 'idb';

/**
 * One IndexedDB database, opened once and reopened when the browser lets go of it.
 *
 * Each device store is its own database (`<slug>-cache`, `<slug>-outbox`) rather than one
 * database with several stores. Layers add stores by adding files, and a shared database would
 * make every new store a version bump in somebody else's upgrade function.
 */
export function opener<Schema extends DBSchema>(
  name: string,
  version: number,
  upgrade: NonNullable<OpenDBCallbacks<Schema>['upgrade']>,
): () => Promise<IDBPDatabase<Schema>> {
  let open: Promise<IDBPDatabase<Schema>> | null = null;

  return () => {
    open ??= openDB<Schema>(name, version, {
      upgrade,
      /*
        Another tab wants a newer version and this connection is in its way. Letting go costs
        a reopen; holding on means the other tab's open never resolves, and its store is gone
        for the session.
      */
      blocking() {
        const held = open;
        open = null;
        void held?.then((db) => db.close());
      },
      // The browser closed it under us. Reopen next time rather than hold a dead handle.
      terminated() {
        open = null;
      },
    });
    return open;
  };
}
