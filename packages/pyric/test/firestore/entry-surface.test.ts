/**
 * Characterization guard for the `pyric/firestore` public surface.
 *
 * `src/firestore/index.ts` is the `pyric/firestore` package subpath export.
 * Its export surface is a published contract. This test freezes the runtime
 * (value) export names so a refactor of the entry — for example splitting it
 * into per-family modules behind a barrel — cannot silently add or drop a
 * symbol.
 *
 * Type-only exports are guarded separately by `tsc` (the build) and by the
 * packaging gate; this test covers the runtime `Object.keys` surface.
 */
import { describe, expect, test } from 'bun:test';
import * as firestore from '../../src/firestore/index.js';

/** The 111 value (runtime) exports of `pyric/firestore`, sorted. Frozen. */
const EXPECTED_VALUE_EXPORTS: readonly string[] = [
  "AbstractUserDataWriter", "AggregateField", "AggregateQuerySnapshot", "Bytes",
  "CACHE_SIZE_UNLIMITED", "CollectionReference", "DocumentReference", "DocumentSnapshot",
  "FieldPath", "FieldValue", "Firestore", "FirestoreError", "GeoPoint", "LoadBundleTask",
  "PersistentCacheIndexManager", "Query", "QueryCompositeFilterConstraint", "QueryConstraint",
  "QueryDocumentSnapshot", "QueryEndAtConstraint", "QueryFieldFilterConstraint",
  "QueryLimitConstraint", "QueryOrderByConstraint", "QuerySnapshot", "QueryStartAtConstraint",
  "SandboxError", "SnapshotMetadata", "TARGET_SYMBOL", "Timestamp", "Transaction",
  "VectorValue", "WriteBatch", "actingAs", "addDoc", "aggregateFieldEqual",
  "aggregateQuerySnapshotEqual", "and", "arrayRemove", "arrayUnion", "average",
  "clearIndexedDbPersistence", "collection", "collectionGroup", "connectFirestoreEmulator",
  "count", "createFirestoreDataTools", "createFirestoreInspectTools",
  "deleteAllPersistentCacheIndexes", "deleteDoc", "deleteField", "disableNetwork",
  "disablePersistentCacheIndexAutoCreation", "doc", "documentId", "documentSnapshotFromJSON",
  "enableIndexedDbPersistence", "enableMultiTabIndexedDbPersistence", "enableNetwork",
  "enablePersistentCacheIndexAutoCreation", "endAt", "endBefore", "ensureFirestoreConfigured",
  "executeWrite", "getAdminFirestore", "getAggregateFromServer", "getCountFromServer",
  "getDoc", "getDocFromCache", "getDocFromServer", "getDocs", "getDocsFromCache",
  "getDocsFromServer", "getFirestore", "getPersistentCacheIndexManager", "increment",
  "initializeFirestore", "limit", "limitToLast", "loadBundle", "memoryEagerGarbageCollector",
  "memoryLocalCache", "memoryLruGarbageCollector", "namedQuery", "onSnapshot",
  "onSnapshotResume", "onSnapshotsInSync", "or", "orderBy", "persistentLocalCache",
  "persistentMultipleTabManager", "persistentSingleTabManager", "query", "queryEqual",
  "querySnapshotFromJSON", "refEqual", "runTransaction", "serverTimestamp", "setDoc",
  "setIndexConfiguration", "setLogLevel", "snapshotEqual", "startAfter", "startAt", "sum",
  "terminate", "updateDoc", "vector", "waitForPendingWrites", "where", "withConverter",
  "writeBatch",
];

describe('pyric/firestore export surface', () => {
  test('runtime value exports are exactly the frozen set', () => {
    const actual = Object.keys(firestore).sort();
    expect(actual).toEqual([...EXPECTED_VALUE_EXPORTS].sort());
  });

  test('every frozen value export is defined (not accidentally undefined)', () => {
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect(
        (firestore as Record<string, unknown>)[name],
        `export "${name}" must be defined`,
      ).toBeDefined();
    }
  });
});
