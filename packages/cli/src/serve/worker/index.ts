/**
 * Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).
 *
 * This barrel exports ONLY the leaf client + the wire-protocol types — the
 * pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
 * connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
 * does NOT re-export `host.ts`/`entry.ts`:
 *   - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
 *     the backend) — node/engine-heavy, never wanted in a page bundle.
 *   - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.
 *
 * `client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
 * and type-only `pyric/sandbox` (erased at build), so this entry stays free of
 * the ~10 MB rules/sandbox engine — safe to import from any browser app.
 *
 * Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
 * `import { getFirestore, subscribeEvents, setLens } from
 * '@pyric/cli/serve/worker'` and reach the live SharedWorker backend.
 */

export {
  // Bridge-peer relay seams (leaf-safe: ids are re-minted in-page, frames go
  // over the worker port). The served page wires these into `connectBridge`'s
  // `dispatcher`/`workerRelay` (entries/runtime.ts); Pyric Studio reuses the
  // SAME wiring (studio's clients/bridge-peer.ts) so a Studio-only session
  // still serves agent tool-calls + remote worker-ops.
  callTool,
  relayWorkerOp,
  relayWorkerSub,
  // Op provenance: Studio declares itself as the issuer of the ops THIS
  // client-module instance constructs (per-bundle state; the served app's
  // own bundle remains app-attributed by its service handles). Traffic uses the resulting source to
  // filter Studio-driven ops out of the app's stream.
  setOpIssuer,
  // Connect + handles
  getFirestore,
  getAuth,
  getWorkerVersion,
  getWorkerInstanceId,
  exportWorkerState,
  importWorkerState,
  saveWorkerBranch,
  listWorkerBranches,
  switchWorkerBranch,
  deleteWorkerBranch,
  type ClientDb,
  type ClientAuth,
  type ClientUser,
  type ClientUserCredential,
  type DocRefHandle,
  type CollRefHandle,
  type QueryHandle,
  type AnyHandle,
  type Unsubscribe,
  type ClientDocSnapshot,
  type ClientQuerySnapshot,
  // Path + query factories
  doc,
  collection,
  collectionGroup,
  query,
  where,
  and,
  or,
  orderBy,
  limit,
  limitToLast,
  startAt,
  startAfter,
  endAt,
  endBefore,
  // Sentinels
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  deleteField,
  // Firestore execution
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  getCountFromServer,
  getAggregateFromServer,
  count,
  sum,
  average,
  listRootCollections,
  listSubcollections,
  onSnapshot,
  writeBatch,
  runTransaction,
  setRules,
  setFirestoreRules,
  setDatabaseRules,
  getActiveRules,
  getRulesStatus,
  adminGetDocument,
  adminListDocuments,
  adminSetDocument,
  adminDeleteDocument,
  adminReadState,
  type ClientWriteBatch,
  type ClientTransaction,
  // Auth
  createUserWithEmailAndPassword,
  // Admin user-DB ops (Pyric Studio data browse)
  listUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeleteUser,
  adminClearUsers,
  // Sign-in provider config (Pyric Studio S-AUTH)
  getProviderConfig,
  setProviderConfig,
  signInWithEmailAndPassword,
  signInAnonymously,
  signOut,
  acceptProviderCredential,
  onAuthStateChanged,
  onIdTokenChanged,
  getIdToken,
  getIdTokenResult,
  setPersistence,
  connectAuthEmulator,
  inMemoryPersistence,
  browserSessionPersistence,
  browserLocalPersistence,
  // Auth lens (Pyric Studio — admin / impersonation / app-session)
  setLens,
  getLens,
  // Storage (Pyric Studio data browse): worker-backed FirebaseStorage mirror
  getStorage,
  ref,
  listAll,
  getMetadata,
  getBlob,
  getDownloadURL,
  // Storage byte ops (worker-mode uploads/reads via the base64 protocol)
  uploadBytes,
  getBytes,
  deleteObject,
  type ClientFirebaseStorage,
  type ClientStorageReference,
  type ClientSettableMetadata,
  // Event stream (Pyric Studio keystone — onEvent/history over the port)
  subscribeEvents,
  eventHistory,
  // Connected-page presence (#227)
  startPresence,
  subscribePresence,
  mintPresenceClientId,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_STALE_MS,
  type PresenceSession,
  type PresenceSnapshot,
  type PresenceClientKind,
  type PresenceVisibility,
  // Sandbox snapshot export (Pyric Studio rules re-run: fork + test edited rules)
  getSnapshot,
  // RTDB shared-worker preview bridge. Aliased to avoid colliding with Storage
  // `ref` and Firestore sentinels in this worker barrel.
  rtdbGetDatabase,
  rtdbRef,
  rtdbChild,
  rtdbGet,
  rtdbSet,
  rtdbUpdate,
  rtdbRemove,
  rtdbPush,
  rtdbOnValue,
  rtdbOff,
  rtdbServerTimestamp,
  rtdbConnectDatabaseEmulator,
  adminReadRtdbState,
  adminSetRtdbValue,
  adminUpdateRtdbValue,
  adminDeleteRtdbValue,
  adminSubscribeRtdbValue,
  type ClientRtdb,
  type RtdbRefHandle,
  type RtdbDataSnapshot,
} from './client.js';

export type {
  AuthPersistenceMode,
  SerializedUser,
  SerializedUserCredential,
  SerializedIdTokenResult,
  ResolvedIdentity,
} from './protocol.js';
