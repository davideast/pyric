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

/** The 73 value (runtime) exports of `pyric/firestore`, sorted. Frozen. */
const EXPECTED_VALUE_EXPORTS: readonly string[] = [
  'Bytes', 'FieldPath', 'FieldValue', 'GeoPoint', 'SandboxError', 'TARGET_SYMBOL',
  'Timestamp', 'VectorValue', 'actingAs', 'addDoc', 'and', 'arrayRemove',
  'arrayUnion', 'average', 'clearIndexedDbPersistence', 'collection',
  'collectionGroup', 'connectFirestoreEmulator', 'count', 'createFirestoreDataTools',
  'createFirestoreInspectTools', 'deleteDoc', 'deleteField', 'disableNetwork', 'doc',
  'documentId', 'enableIndexedDbPersistence', 'enableMultiTabIndexedDbPersistence',
  'enableNetwork', 'endAt', 'endBefore', 'getAdminFirestore', 'getAggregateFromServer',
  'getCountFromServer', 'getDoc', 'getDocFromCache', 'getDocFromServer', 'getDocs',
  'getDocsFromCache', 'getDocsFromServer', 'getFirestore', 'increment',
  'initializeFirestore', 'limit', 'limitToLast', 'memoryEagerGarbageCollector',
  'memoryLocalCache', 'memoryLruGarbageCollector', 'onSnapshot', 'onSnapshotsInSync',
  'or', 'orderBy', 'persistentLocalCache', 'persistentMultipleTabManager',
  'persistentSingleTabManager', 'query', 'queryEqual', 'refEqual', 'runTransaction',
  'serverTimestamp', 'setDoc', 'setLogLevel', 'snapshotEqual', 'startAfter',
  'startAt', 'sum', 'terminate', 'updateDoc', 'vector', 'waitForPendingWrites', 'where',
  'withConverter', 'writeBatch',
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
