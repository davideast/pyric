/**
 * Entry-path conformance program — `pyric/app` + `pyric/firestore`.
 *
 * Adapted from Firebase's official web quickstart and persistence guides:
 *   - https://firebase.google.com/docs/firestore/quickstart
 *     (`initializeApp`, `getFirestore`, `collection` + `addDoc`, the exact
 *     `{ first, last, born }` sample document)
 *   - https://firebase.google.com/docs/firestore/manage-data/enable-offline
 *     (`initializeFirestore` with a `localCache`, `persistentLocalCache`,
 *     the tab managers, `clearIndexedDbPersistence`, `waitForPendingWrites`,
 *     `enableNetwork` / `disableNetwork`, `terminate`)
 *
 * This program deliberately exercises EVERY initialization entry point the
 * firestore surface exposes, not one of them. `getFirestore` and
 * `initializeFirestore` are alternative front doors, and the persistence
 * builders (`persistentLocalCache` / `memoryLocalCache` and their tab
 * managers and collectors) are alternative cache strategies a real app picks
 * between. The entry-path gate proves a symbol works only if a program
 * actually imports and runs it, so picking one door here would drop the other
 * from the proven set. Every door is walked, and where initialization choices
 * are genuinely exclusive, each is exercised on its own Firebase app.
 *
 * The initialization is byte-for-byte Firebase-shaped; package resolution is
 * the only switch between the Firebase and Pyric implementations.
 */
import { initializeApp } from 'pyric/app';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  persistentMultipleTabManager,
  memoryLocalCache,
  memoryEagerGarbageCollector,
  memoryLruGarbageCollector,
  enableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence,
  clearIndexedDbPersistence,
  waitForPendingWrites,
  enableNetwork,
  disableNetwork,
  onSnapshotsInSync,
  terminate,
  collection,
  addDoc,
  getDoc,
  getDocFromServer,
  getDocFromCache,
  onSnapshot,
} from 'pyric/firestore';

export async function run(): Promise<void> {
  const app = initializeApp({ projectId: 'entry-path-project' });

  // https://firebase.google.com/docs/firestore/manage-data/enable-offline —
  // the explicit-init pattern: choose a cache strategy up front. This is the
  // persistent single-tab cache.
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentSingleTabManager({ forceOwnership: false }),
      cacheSizeBytes: 40 * 1024 * 1024,
    }),
  });

  // `getFirestore` is the other initialization front door; obtain a handle
  // through it too so the entry point is proven. The sandbox mints a fresh
  // Firestore handle per call rather than caching one per app, so this is not
  // object-identical to `db` — both are usable handles onto the same store.
  const dbDefault = getFirestore(app);
  if (typeof dbDefault !== 'object' || dbDefault === null) {
    throw new Error('getFirestore did not return a Firestore instance');
  }

  // The remaining cache strategies are inert config tokens a real app would
  // pass to `initializeFirestore` instead of the one above. Build each so the
  // builder entry points are proven, and confirm each produces a config token.
  const alternativeCaches = [
    memoryLocalCache({ garbageCollector: memoryLruGarbageCollector({ cacheSizeBytes: 8 * 1024 * 1024 }) }),
    memoryLocalCache({ garbageCollector: memoryEagerGarbageCollector() }),
    persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  ];
  if (alternativeCaches.some((cache) => typeof cache !== 'object' || cache === null)) {
    throw new Error('a cache builder did not return a config token');
  }

  // Legacy persistence toggles are alternative startup patterns, not calls an
  // app may stack on an already initialized instance. Exercise each against a
  // fresh service handle so the entry path remains valid production usage.
  const legacySingleApp = initializeApp(
    { projectId: 'entry-path-project' },
    'entry-path-legacy-single',
  );
  const legacyMultiApp = initializeApp(
    { projectId: 'entry-path-project' },
    'entry-path-legacy-multi',
  );
  const dbLegacySingle = getFirestore(legacySingleApp);
  const dbLegacyMulti = getFirestore(legacyMultiApp);
  await clearIndexedDbPersistence(db);
  await enableIndexedDbPersistence(dbLegacySingle);
  await enableMultiTabIndexedDbPersistence(dbLegacyMulti);

  // https://firebase.google.com/docs/firestore/quickstart — the one real
  // write this program performs and asserts.
  const docRef = await addDoc(collection(db, 'users'), {
    first: 'Ada',
    last: 'Lovelace',
    born: 1815,
  });
  if (!docRef.id || typeof docRef.id !== 'string') {
    throw new Error(`addDoc did not return a usable document id (got ${JSON.stringify(docRef.id)})`);
  }

  // Flush, then read the write back through every read entry point: the
  // default read, the force-from-server read, and the from-cache read.
  await waitForPendingWrites(db);
  const reads = [
    ['getDoc', await getDoc(docRef)],
    ['getDocFromServer', await getDocFromServer(docRef)],
    ['getDocFromCache', await getDocFromCache(docRef)],
  ] as const;
  for (const [label, snap] of reads) {
    const exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
    if (!exists || snap.data()?.first !== 'Ada') {
      throw new Error(`${label} did not read back the written document`);
    }
  }

  // The metadata-changes listener option and the in-sync barrier. `onSnapshot`
  // accepts `includeMetadataChanges`, so the option is a real entry point to
  // prove by running it. The per-snapshot metadata fields it would drive
  // (`fromCache` / `hasPendingWrites`) are not modeled on the sandbox snapshot,
  // so this proves the listener, not metadata reads. Register and unsubscribe.
  const unsubscribeSnapshot = onSnapshot(docRef, { includeMetadataChanges: true }, () => {});
  const unsubscribeInSync = onSnapshotsInSync(db, () => {});
  unsubscribeSnapshot();
  unsubscribeInSync();

  // The network toggles round-trip: disable then re-enable.
  await disableNetwork(db);
  await enableNetwork(db);

  // Teardown is the last thing the program does — `terminate` disposes the
  // instance, so nothing runs after it.
  await Promise.all([
    terminate(db),
    terminate(dbLegacySingle),
    terminate(dbLegacyMulti),
  ]);
}
