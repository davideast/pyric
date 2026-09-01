/**
 * Characterization guard for the worker CLIENT public surface.
 *
 * `serve/worker/index.ts` is the `@pyric/cli/serve/worker` package subpath
 * export. This test freezes that public runtime surface while allowing its
 * implementation to remain split into service-owned family modules.
 *
 * Type-only exports are guarded separately by `tsc` (the build) and by the
 * packaging gate; this test covers the runtime `Object.keys` surface.
 */
import { describe, expect, test } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';

/** Runtime exports of the public worker package subpath, frozen. */
const EXPECTED_VALUE_EXPORTS: readonly string[] = [
  'AUTH_LENS_STORAGE_KEY',
  'PRESENCE_HEARTBEAT_INTERVAL_MS', 'PRESENCE_STALE_MS',
  'PYRIC_WORKER_GENERATION_KEY', 'PYRIC_WORKER_NAME', 'PYRIC_WORKER_URL', 'RtdbOnDisconnect',
  'acceptProviderCredential', 'addDoc', 'adminClearUsers', 'adminCreateUser',
  'adminDeleteDocument', 'adminDeleteRtdbValue', 'adminDeleteUser', 'adminGetDocument',
  'adminListDocuments', 'adminReadRtdbState', 'adminReadState', 'adminSetDocument',
  'adminSetRtdbValue', 'adminSubscribeRtdbValue', 'adminUpdateRtdbValue', 'adminUpdateUser',
  'and', 'arrayRemove', 'arrayUnion', 'average',
  'browserLocalPersistence', 'browserSessionPersistence', 'callTool', 'collection',
  'collectionGroup', 'connectAuthEmulator', 'count', 'createUserWithEmailAndPassword',
  'createWorkerReplacement', 'deleteDoc', 'deleteField', 'deleteObject',
  'deleteWorkerBranch', 'disconnectClient', 'doc', 'endAt',
  'endBefore', 'eventHistory', 'exportWorkerState', 'getActiveRules',
  'getAggregateFromServer', 'getAuth', 'getBlob', 'getBytes', 'getCountFromServer',
  'getDoc', 'getDocs', 'getDownloadURL', 'getFirestore', 'getIdToken', 'getIdTokenResult', 'getLens',
  'getMetadata', 'getProviderConfig', 'getRulesStatus', 'getSnapshot',
  'getStorage', 'getWorkerInstanceId', 'getWorkerVersion', 'hydrateLensFromStorage', 'importWorkerState',
  'increment', 'inMemoryPersistence', 'limit', 'limitToLast', 'listAll',
  'listRootCollections', 'listSubcollections', 'listUsers', 'listWorkerBranches',
  'mintPresenceClientId',
  'onAuthStateChanged', 'onIdTokenChanged', 'onSnapshot', 'onWorkerRuntimeReload',
  'or', 'orderBy', 'ownClientUntilPagehide', 'preflightWorkerEpochStorage', 'query',
  'readPyricRuntimeManifest', 'ref', 'relayWorkerOp', 'relayWorkerSub',
  'rememberWorkerEpoch', 'resetAll', 'retireWorkerRuntime', 'rtdbChild',
  'rtdbConnectDatabaseEmulator', 'rtdbGet', 'rtdbGetDatabase', 'rtdbGoOffline',
  'rtdbGoOnline', 'rtdbOff', 'rtdbOnChildAdded', 'rtdbOnChildChanged', 'rtdbOnChildMoved',
  'rtdbOnChildRemoved', 'rtdbOnDisconnect', 'rtdbOnValue', 'rtdbPush', 'rtdbRef',
  'rtdbRemove', 'rtdbRunTransaction', 'rtdbServerTimestamp', 'rtdbSet', 'rtdbSetPriority',
  'rtdbSetWithPriority', 'rtdbUpdate',
  'runTransaction', 'saveWorkerBranch', 'serverTimestamp', 'setDatabaseRules', 'setDoc',
  'setFirestoreRules', 'setLens', 'setOpIssuer', 'setPersistence',
  'setProviderConfig', 'setRules', 'signInAnonymously',
  'signInWithEmailAndPassword', 'signOut', 'startAfter', 'startAt', 'startPresence',
  'subscribeEvents', 'subscribeLens', 'subscribePresence',
  'sum', 'switchWorkerBranch', 'updateDoc', 'uploadBytes', 'uploadString', 'uploadBytesResumable', 'where', 'workerNameForEpoch',
  'writeBatch',
];

describe('worker client export surface', () => {
  test('runtime value exports are exactly the frozen set', () => {
    const actual = Object.keys(client).sort();
    expect(actual).toEqual([...EXPECTED_VALUE_EXPORTS].sort());
  });

  test('every frozen value export is defined (not accidentally undefined)', () => {
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect(
        (client as Record<string, unknown>)[name],
        `export "${name}" must be defined`,
      ).toBeDefined();
    }
  });
});
