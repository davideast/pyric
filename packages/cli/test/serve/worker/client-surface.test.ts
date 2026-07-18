/**
 * Characterization guard for the worker CLIENT public surface.
 *
 * `serve/worker/client.ts` is re-exported by `serve/worker/index.ts`, which is
 * the `@pyric/cli/serve/worker` package subpath export. Its export surface is
 * a published contract. This test freezes the runtime (value) export names so a
 * refactor of `client.ts` — for example splitting it into per-family modules
 * behind a barrel — cannot silently add or drop a symbol.
 *
 * Type-only exports are guarded separately by `tsc` (the build) and by the
 * packaging gate; this test covers the runtime `Object.keys` surface.
 */
import { describe, expect, test } from 'bun:test';
import * as client from '../../../src/serve/worker/client.js';

/** The 125 value (runtime) exports of the worker client, sorted. Frozen. */
const EXPECTED_VALUE_EXPORTS: readonly string[] = [
  'PRESENCE_HEARTBEAT_INTERVAL_MS', 'PRESENCE_STALE_MS',
  'acceptProviderCredential', 'addDoc', 'adminClearUsers', 'adminCreateUser',
  'adminDeleteDocument', 'adminDeleteRtdbValue', 'adminDeleteUser', 'adminGetDocument',
  'adminListDocuments', 'adminReadRtdbState', 'adminReadState', 'adminSetDocument',
  'adminSetRtdbValue', 'adminSubscribeRtdbValue', 'adminUpdateRtdbValue', 'adminUpdateUser',
  'aiCountTokens',
  'aiGenerateContent',
  'aiStreamGenerateContent',
  'and', 'arrayRemove', 'arrayUnion', 'average', 'beforeAuthStateChanged',
  'browserLocalPersistence', 'browserSessionPersistence', 'callTool', 'collection',
  'collectionGroup', 'connectAuthEmulator', 'count', 'createUserWithEmailAndPassword',
  'deleteDoc', 'deleteField', 'deleteObject', 'deleteWorkerBranch', 'doc', 'endAt',
  'endBefore', 'eventHistory', 'exportWorkerState', 'getActiveRules',
  'getAggregateFromServer', 'getAuth', 'getBlob', 'getBytes', 'getCountFromServer',
  'getDoc', 'getDocs', 'getDownloadURL', 'getFirestore', 'getIdToken', 'getIdTokenResult', 'getLens',
  'getMetadata', 'getProviderConfig', 'getRulesStatus', 'getSnapshot',
  'getStorage', 'getWorkerInstanceId', 'getWorkerVersion', 'importWorkerState',
  'increment', 'inMemoryPersistence', 'limit', 'limitToLast', 'listAll',
  'listRootCollections', 'listSubcollections', 'listUsers', 'listWorkerBranches',
  'mintPresenceClientId',
  'onAuthStateChanged', 'onIdTokenChanged', 'onSnapshot', 'or', 'orderBy', 'query',
  'ref', 'relayWorkerOp', 'relayWorkerSub', 'resetAll', 'restorePortSession', 'rtdbChild',
  'rtdbConnectDatabaseEmulator', 'rtdbGet', 'rtdbGetDatabase', 'rtdbOff', 'rtdbOnValue',
  'rtdbPush', 'rtdbRef', 'rtdbRemove', 'rtdbServerTimestamp', 'rtdbSet', 'rtdbUpdate',
  'runTransaction', 'saveWorkerBranch', 'serverTimestamp', 'setDatabaseRules', 'setDoc',
  'setFirestoreRules', 'setLens', 'setOpIssuer', 'setPersistence',
  'setProviderConfig', 'setRules', 'signInAnonymously', 'signInWithCredential',
  'signInWithEmailAndPassword', 'signOut', 'startAfter', 'startAt', 'startPresence',
  'subscribeEvents', 'subscribePresence',
  'sum', 'switchWorkerBranch', 'updateDoc', 'updateProfile', 'uploadBytes', 'where',
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
