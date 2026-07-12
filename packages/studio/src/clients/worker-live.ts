/**
 * Studio live data plane: the bridge to the LIVE SharedWorker backend
 * (Wave 2.5a). This is the connective tissue that lets the Studio Vite app reach
 * the SAME `pyric-shared-worker` sandbox the served app + the agent operate, so
 * Studio is "an admin/impersonating client of the same SharedWorker sandbox"
 * (per the design rationale) rather than a separate mirror.
 *
 * WHAT IT WRAPS
 * -------------
 * `@pyric/cli/serve/worker` (the browser-safe worker CLIENT, leaf, engine-free)
 * mirrors `pyric/firestore` + `pyric/auth` over the worker `MessagePort` and now
 * ALSO exposes:
 *   - `subscribeEvents`/`eventHistory`: the unified `onEvent`/`history()` stream,
 *   - `setLens`: the per-op auth lens (`admin` / `as:<uid>` / `app-session`),
 *   - `setPolicy`/`getPolicy`: the runtime confirm-policy (the permission dial).
 *
 * This module adapts those into the seam shapes Studio's features already expect:
 *   - F1 Action Center: an `EventFeed` (`{ history, subscribe }`), built from the
 *     worker's `subscribeEvents` (history-first batch then live events).
 *   - F2 viewer/editor: the worker `ClientDb` + `setLens` for admin / view-as-user.
 *   - F3 permission dial: a `setPolicy(req)` that reaches the worker.
 *   - F4 rules-debug: `setLens({mode:'as',uid})` for "re-run as the user".
 *
 * BROWSER-ONLY. `connectWorkerLive()` returns `null` when no `SharedWorker` is
 * present (SSR / unsupported browser / tests) so the env can fall back to the
 * HTTP-only path. Never throws on a missing SharedWorker.
 */

import type { SandboxEvent, SandboxSnapshot } from 'pyric/sandbox';
import type { Auth } from 'pyric/auth';
import type { FirebaseStorage } from 'pyric/storage';
import type { FirestoreApi } from '@pyric/ui/firestore';
import type { AuthApi } from '@pyric/ui/auth';
import type { StorageApi } from '@pyric/ui/storage';
import {
  getFirestore as workerGetFirestore,
  setOpIssuer,
  getAuth as workerGetAuth,
  getStorage as workerGetStorage,
  ref as workerStorageRef,
  listAll as workerStorageListAll,
  getMetadata as workerStorageGetMetadata,
  getBlob as workerStorageGetBlob,
  uploadBytes as workerStorageUploadBytes,
  getSnapshot as workerGetSnapshot,
  getWorkerInstanceId,
  exportWorkerState,
  importWorkerState,
  saveWorkerBranch,
  listWorkerBranches,
  switchWorkerBranch,
  deleteWorkerBranch,
  subscribeEvents,
  setLens as workerSetLens,
  getLens as workerGetLens,
  setPolicy as workerSetPolicy,
  getPolicy as workerGetPolicy,
  listRootCollections as workerListRootCollections,
  listSubcollections as workerListSubcollections,
  adminListDocuments as workerAdminListDocuments,
  listUsers as workerListUsers,
  adminCreateUser as workerAdminCreateUser,
  adminUpdateUser as workerAdminUpdateUser,
  adminDeleteUser as workerAdminDeleteUser,
  adminClearUsers as workerAdminClearUsers,
  getProviderConfig as workerGetProviderConfig,
  setProviderConfig as workerSetProviderConfig,
  adminReadRtdbState as workerAdminReadRtdbState,
  adminSetRtdbValue as workerAdminSetRtdbValue,
  adminUpdateRtdbValue as workerAdminUpdateRtdbValue,
  adminDeleteRtdbValue as workerAdminDeleteRtdbValue,
  adminSubscribeRtdbValue as workerAdminSubscribeRtdbValue,
  collection as workerCollection,
  doc as workerDoc,
  getDoc as workerGetDoc,
  getDocs as workerGetDocs,
  onSnapshot as workerOnSnapshot,
  setDoc as workerSetDoc,
  deleteDoc as workerDeleteDoc,
  addDoc as workerAddDoc,
  query as workerQuery,
  limit as workerLimit,
  startAfter as workerStartAfter,
  type ClientDb,
  type PolicyRequest,
} from '@pyric/cli/serve/worker';

/**
 * The per-op auth lens Studio drives. Mirrors `pyric/sandbox`'s `AuthLens` /
 * the worker client's lens, re-declared structurally so this module doesn't
 * type-depend on the sandbox engine surface.
 */
export type StudioLens =
  | { mode: 'admin' }
  | { mode: 'as'; uid: string }
  | { mode: 'app-session' };

/**
 * A `{ history, subscribe }` source of `SandboxEvent`s. Structurally identical
 * to F1's `EventFeed` (`features/action-center/feed.ts`), kept as a local
 * declaration so this client (the env layer) doesn't import a feature module.
 */
export interface LiveEventFeed {
  history(): readonly SandboxEvent[];
  subscribe(cb: (event: SandboxEvent) => void): () => void;
}

/**
 * The live data plane handed to features when a SharedWorker is reachable.
 * Each field feeds a specific Wave-2 feature seam (see the file header).
 */
export interface WorkerLivePlane {
  /** The worker-backed Firestore handle (carries the `MessagePort`). */
  db: ClientDb;
  /** F1: the unified event stream as an `EventFeed`. */
  feed: LiveEventFeed;
  /** F2 / F4: set the per-op auth lens (admin / impersonate / app-session). */
  setLens(lens: StudioLens | undefined): void;
  /** Read the active lens back (Studio UI reflects it). */
  getLens(): StudioLens | undefined;
  /** F3: push the permission dial's policy to the worker (runtime store). */
  setPolicy(policy: PolicyRequest): Promise<void>;
  /** Read the active runtime policy back (null until the dial set one). */
  getPolicy(): Promise<PolicyRequest | null>;
  /** F2 data browse: enumerate root collection ids over the worker keyspace. */
  listRootCollections(): Promise<string[]>;
  /** F2 data browse: enumerate subcollection ids under a document path. */
  listSubcollections(docPath: string): Promise<string[]>;
  /** F2 data browse: phantom-inclusive document listing for a collection path
   *  (`phantom: true` = a "missing" parent — descendants but no stored doc). */
  listDocuments(collectionPath: string): Promise<{ path: string; phantom?: boolean }[]>;
  /** RTDB browse: read the full worker-backed RTDB tree with the admin lens. */
  readRtdbState(): Promise<unknown>;
  /** RTDB browse: replace a node with the admin lens. */
  setRtdbValue(path: string, value: unknown): Promise<void>;
  /** RTDB browse: shallow-update a node with the admin lens. */
  updateRtdbValue(path: string, values: Record<string, unknown>): Promise<void>;
  /** RTDB browse: delete a node with the admin lens. */
  deleteRtdbValue(path: string): Promise<void>;
  /** RTDB viewer: live value subscription at a path with the admin lens —
   *  `next` fires with the subtree's plain JSON value on subscribe and after
   *  every write. Returns the unsubscribe. */
  subscribeRtdbValue(
    path: string,
    next: (value: unknown) => void,
    error?: (err: unknown) => void,
  ): () => void;
  /**
   * F2 data browse: the worker client's modular Firestore fns as an injectable
   * {@link FirestoreApi} bundle. Studio feeds this to `@pyric/ui`'s
   * `FirestoreApiProvider` so the data grids drive the LIVE worker backend (the
   * worker handles/snapshots are runtime-compatible with the in-process shapes
   * the grids use, so the bundle is cast to the in-process signatures here).
   */
  firestoreApi: FirestoreApi;
  /** F2 data browse: the worker-backed Auth handle (the user DB the served app
   *  + agent share). Passed to `useAuthUsers` as the auth handle. */
  auth: Auth;
  /** F2 data browse: the worker auth admin ops as an injectable {@link AuthApi}
   *  bundle (Studio feeds it to `@pyric/ui`'s `AuthApiProvider`). `subscribeUsers`
   *  re-lists on the worker event feed (coarse "user DB changed"). */
  authApi: AuthApi;
  /** F2 data browse: the worker-backed Storage handle (the object store the
   *  served app + agent share). Passed to the storage hooks as the handle. */
  storage: FirebaseStorage;
  /** F2 data browse: the worker storage ops as an injectable {@link StorageApi}
   *  bundle (Studio feeds it to `@pyric/ui`'s `StorageApiProvider`). */
  storageApi: StorageApi;
  /** F4 rules re-run: export the worker sandbox snapshot. Studio forks it
   *  locally to test a denied op against edited rules / re-issue as the user,
   *  on a throwaway branch (no live mutation). */
  getSnapshot(): Promise<SandboxSnapshot>;
  /** Stable per-SharedWorker instance id, so the UI can tell WHICH sandbox
   *  instance this is — the same `localhost:<port>` in a different browser
   *  profile is a separate instance. Studio renders a human-friendly slug. */
  instanceId(): Promise<string>;
  /** Phase 2 (transfer): export the full sandbox state as a portable bundle
   *  string. Download it, then {@link importState} it into another instance. */
  exportState(): Promise<string>;
  /** Phase 2 (clobber): replace this sandbox's ENTIRE state with a bundle. */
  importState(bundle: string): Promise<void>;
  /** Phase 3: save the live sandbox as a named branch (a saved state). */
  saveBranch(name: string): Promise<void>;
  /** Phase 3: list this instance's saved branch names. */
  listBranches(): Promise<string[]>;
  /** Phase 3 (clobber): switch the live sandbox to a named branch. */
  switchBranch(name: string): Promise<void>;
  /** Phase 3: delete a named branch. */
  deleteBranch(name: string): Promise<void>;
}

/**
 * URL of the served SharedWorker script under `pyric dev`. The worker is
 * served at the SDK namespace; this is the stable path the served page uses.
 */
export const DEFAULT_WORKER_URL = '/__pyric/sdk/worker.js';

/**
 * Build a {@link LiveEventFeed} over the worker client's event channel.
 *
 * `subscribeEvents` delivers the initial `history()` as the FIRST batch, then
 * one live event per subsequent batch.
 *
 * WHY THE HISTORY IS DELIVERED TO SUBSCRIBERS, NOT JUST BUFFERED:
 * The worker subscription is opened lazily on the FIRST `subscribe()` and its
 * history batch arrives ASYNCHRONOUSLY (a port round-trip). A consumer like
 * `useActionDigest` reads `feed.history()` synchronously (empty at that instant)
 * THEN subscribes, so if history were only buffered for a later `history()`
 * call, the backlog would be silently dropped. Instead we fan the history batch
 * out to the live subscribers too (each event once), so an early subscriber
 * still receives the full backlog. We also keep `historySnapshot` updated for a
 * late `history()` reader (mirrors `sandbox.history()` growing).
 *
 * One worker subscription backs any number of feed subscribers: opened on first
 * subscribe, torn down when the last unsubscribes.
 */
export function workerEventFeed(db: ClientDb): LiveEventFeed {
  // The running snapshot of events seen so far (history + live), kept so a late
  // `feed.history()` call returns the backlog.
  let historySnapshot: readonly SandboxEvent[] = [];
  let sawHistory = false;
  const subscribers = new Set<(event: SandboxEvent) => void>();
  let workerUnsub: (() => void) | null = null;

  function ensureWorkerSub(): void {
    if (workerUnsub) return;
    workerUnsub = subscribeEvents(db, (events) => {
      const isHistoryBatch = !sawHistory;
      if (isHistoryBatch) {
        sawHistory = true;
        // The first batch is the full `history()` snapshot: seed it…
        historySnapshot = events;
      } else {
        // …subsequent batches are live; append to the running snapshot.
        historySnapshot = [...historySnapshot, ...events];
      }
      // Fan EVERY event (history backlog included) out to subscribers, so an
      // early subscriber that read an empty `history()` still gets the backlog.
      for (const event of events) {
        for (const cb of subscribers) cb(event);
      }
    });
  }

  return {
    history: () => historySnapshot,
    subscribe: (cb) => {
      // CONSUMER CONTRACT (matches `useActionDigest`): read `history()` THEN
      // `subscribe()`. The FIRST subscriber sees an empty `history()` (the
      // worker round-trip is in flight) and receives the backlog via this
      // subscription; a LATER subscriber reads the now-populated `history()` and
      // only streams new events. Either way each event is folded exactly once.
      subscribers.add(cb);
      ensureWorkerSub();
      return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0 && workerUnsub) {
          workerUnsub();
          workerUnsub = null;
          // Reset so a later re-subscribe re-seeds history from the worker.
          sawHistory = false;
          historySnapshot = [];
        }
      };
    },
  };
}

/**
 * Bind one worker Firestore operation to Studio's admin lens.
 *
 * The worker client keeps its default lens in module state because rules-debug
 * briefly impersonates a user. The data viewer is a separate admin surface and
 * must never inherit that mutable choice. Worker operations stamp and post
 * their request synchronously before returning, so the prior lens can be
 * restored immediately while the returned promise or subscription continues.
 */
function pinAdminLens<Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    const previous = workerGetLens();
    workerSetLens({ mode: 'admin' });
    try {
      return operation(...args);
    } finally {
      workerSetLens(previous);
    }
  };
}

/**
 * Connect Studio to the live SharedWorker backend, returning the {@link WorkerLivePlane},
 * or `null` when no `SharedWorker` is available (SSR / unsupported browser /
 * tests), so the env can fall back to the HTTP-only path. Never throws.
 *
 * The returned plane shares ONE worker port across the Firestore handle, the
 * event feed, the lens, and the policy, so a `setLens(...)` choice applies to
 * the same backend the feed observes (the single-backend invariant).
 */
export function connectWorkerLive(
  workerUrl: string = DEFAULT_WORKER_URL,
): WorkerLivePlane | null {
  if (typeof SharedWorker === 'undefined') return null;
  // Studio declares itself the issuer of every op THIS bundle's worker
  // client constructs (data viewers, typeahead index, seed actions) so the
  // traffic stream can attribute — and filter — Studio-driven ops. The
  // served app runs its own bundle instance and stays untagged; bridge
  // relays forward verbatim (see @pyric/cli serve/worker client).
  setOpIssuer('studio');
  let db: ClientDb;
  try {
    db = workerGetFirestore(workerUrl);
  } catch {
    // getFirestore throws if SharedWorker construction fails (e.g. file://),
    // treat as "no live plane" so the env falls back cleanly.
    return null;
  }

  // One feed shared by F1 and the auth `subscribeUsers` re-list signal. One auth
  // handle reusing the same port (the single-backend invariant).
  const feed = workerEventFeed(db);
  const authHandle = workerGetAuth(db);

  return {
    db,
    instanceId: () => getWorkerInstanceId(db),
    exportState: () => exportWorkerState(db),
    importState: (bundle) => importWorkerState(db, bundle),
    saveBranch: (name) => saveWorkerBranch(db, name),
    listBranches: () => listWorkerBranches(db),
    switchBranch: (name) => switchWorkerBranch(db, name),
    deleteBranch: (name) => deleteWorkerBranch(db, name),
    feed,
    setLens: (lens) => workerSetLens(lens),
    getLens: () => workerGetLens() as StudioLens | undefined,
    setPolicy: (policy) => workerSetPolicy(db, policy),
    getPolicy: () => workerGetPolicy(db),
    listRootCollections: () => workerListRootCollections(db),
    listSubcollections: (docPath) => workerListSubcollections(db, docPath),
    // Browse-only listing: drop `data` at this seam (the pane only needs the
    // id + the phantom flag; document CONTENT always reads via getDoc).
    listDocuments: async (collectionPath) =>
      (await workerAdminListDocuments(db, collectionPath)).map(({ path, phantom }) => ({
        path,
        phantom,
      })),
    readRtdbState: () => workerAdminReadRtdbState(db),
    setRtdbValue: (path, value) => workerAdminSetRtdbValue(db, path, value),
    updateRtdbValue: (path, values) => workerAdminUpdateRtdbValue(db, path, values),
    deleteRtdbValue: (path) => workerAdminDeleteRtdbValue(db, path),
    subscribeRtdbValue: (path, next, error) =>
      workerAdminSubscribeRtdbValue(db, path, next, error),
    // The worker client's modular fns, cast to the in-process FirestoreApi
    // signatures (`@pyric/ui` is typed against `pyric/firestore`; the worker
    // handles + snapshots are runtime-compatible at the grid's surface).
    firestoreApi: {
      collection: workerCollection,
      doc: workerDoc,
      getDoc: pinAdminLens(workerGetDoc),
      getDocs: pinAdminLens(workerGetDocs),
      onSnapshot: pinAdminLens(workerOnSnapshot),
      setDoc: pinAdminLens(workerSetDoc),
      deleteDoc: pinAdminLens(workerDeleteDoc),
      addDoc: pinAdminLens(workerAddDoc),
      query: workerQuery,
      limit: workerLimit,
      startAfter: workerStartAfter,
    } as unknown as FirestoreApi,
    auth: authHandle as unknown as Auth,
    // The worker auth admin ops as an AuthApi bundle (cast to the in-process
    // signatures). `subscribeUsers` rides the event feed, FILTERED to auth
    // service mutations (user create/update/delete/clear, sign-ins, provider
    // links) — a Firestore write must not fire a `listUsers` RPC.
    authApi: {
      listUsers: () => workerListUsers(authHandle),
      subscribeUsers: (_auth: unknown, cb: () => void) =>
        feed.subscribe((event) => {
          if (event.kind === 'service_mutation' && event.service === 'auth') cb();
        }),
      createUser: (_auth: unknown, request: unknown) =>
        workerAdminCreateUser(authHandle, request as Parameters<typeof workerAdminCreateUser>[1]),
      updateUser: (_auth: unknown, uid: string, request: unknown) =>
        workerAdminUpdateUser(authHandle, uid, request as Parameters<typeof workerAdminUpdateUser>[2]),
      deleteUser: (_auth: unknown, uid: string) => workerAdminDeleteUser(authHandle, uid),
      clearUsers: () => workerAdminClearUsers(authHandle),
      // Sign-in provider config: rides the same shared event feed, filtered
      // to the ONE op that can change it (`provider_config_update`) — an
      // unrelated sandbox event must not fire a `getProviderConfig` RPC.
      getAuthProviderConfig: () => workerGetProviderConfig(authHandle),
      setAuthProviderConfig: (_auth: unknown, providerId: string, enabled: boolean) =>
        workerSetProviderConfig(authHandle, providerId, enabled),
      subscribeAuthProviderConfig: (_auth: unknown, cb: () => void) =>
        feed.subscribe((event) => {
          if (event.kind === 'service_mutation' && event.op === 'provider_config_update') cb();
        }),
    } as unknown as AuthApi,
    storage: workerGetStorage(db) as unknown as FirebaseStorage,
    // The worker storage ops as a StorageApi bundle. `uploadBytes` is the
    // base64 `storage.putBytes` MessagePort op — capped at 8 MiB per payload
    // on both ends; an over-cap upload fails that file's task with the typed
    // too-large error (the rest of a batch proceeds).
    storageApi: {
      ref: workerStorageRef,
      listAll: workerStorageListAll,
      getMetadata: workerStorageGetMetadata,
      getBlob: workerStorageGetBlob,
      uploadBytes: workerStorageUploadBytes,
    } as unknown as StorageApi,
    getSnapshot: () => workerGetSnapshot(db),
  };
}
