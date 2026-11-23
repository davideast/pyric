/**
 * Studio data source: the one seam every surface reads from.
 *
 * Studio has two ways to get live `pyric/*` handles:
 *
 *   1. THE DEV-SEED (review / `vite dev`). `DevSeedProvider` builds an in-page
 *      seeded sandbox so Studio renders real data with no server. This is what
 *      makes the branch reviewable.
 *   2. THE ENVIRONMENT (`pyric dev --ui`). `EnvironmentProvider` resolves the
 *      durable `local` backend; `useStudioData` hydrates a sandbox from it.
 *
 * Surfaces shouldn't care which one is live. This module resolves both and
 * prefers the dev-seed when it's active, falling back to the env path otherwise.
 * The shape it returns ({@link StudioDataState}) is exactly what the existing F2
 * panes already consume, so wiring a surface to live data is a one-import swap.
 *
 * All hooks here run unconditionally (dev-seed read, env read, env-data hydrate)
 * so the rules-of-hooks hold regardless of which source ends up driving.
 *
 * The other reads and writes over this seam live beside it, one concept per
 * file: `studio-events.ts` for the event stream and what is derived from it,
 * `studio-writes.ts` for seeding, clearing, and deploying rules,
 * `studio-saved-states.ts` for instance identity, transfer, and named saved
 * states, and `studio-rules-source.ts` for the deployed rules text.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_FIRESTORE_DATABASE } from 'pyric/firestore/internal';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { useDevSeed } from '../dev/DevSeedProvider.js';
import { useEnvironment } from './environment.js';
import { useHostAnswered } from './live-status.js';
import { useIsSandboxWorkerAllowed, useSandboxWorkerLive } from './use-sandbox-worker-gate.js';
import type { WorkerLivePlane } from '../env.js';
import {
  listDocumentsForBrowse,
  scopeHandlesForDatabase,
  useStudioData,
  type StudioDataHandles,
  type StudioDataState,
} from '../features/data/sandbox.js';

/** Lift the dev-seed's `SeededHandles` to the richer `StudioDataHandles` the F2
 *  panes expect (the only delta is the keyspace-listing helpers, which come
 *  straight off the sandbox's internal env). */
function handlesFromSeed(seed: {
  sandbox: StudioDataHandles['sandbox'];
  app: StudioDataHandles['app'];
  firestore: StudioDataHandles['firestore'];
  adminFirestore: StudioDataHandles['adminFirestore'];
  auth: StudioDataHandles['auth'];
  storage: StudioDataHandles['storage'];
}): StudioDataHandles {
  const env = getInternalEnv(seed.sandbox);
  return {
    sandbox: seed.sandbox,
    app: seed.app,
    firestore: seed.firestore,
    adminFirestore: seed.adminFirestore,
    auth: seed.auth,
    storage: seed.storage,
    listRootCollections: () => env.listRootCollections(),
    listSubcollections: (docPath: string) => env.listSubcollections(docPath),
    listDocuments: (collectionPath: string) => listDocumentsForBrowse(env, collectionPath),
  };
}

/**
 * The resolved Studio data handles, dev-seed first.
 *
 * - dev-seed `ready`   -> live handles built from the seeded sandbox.
 * - dev-seed `pending` -> pending (seeding the in-page fixture).
 * - dev-seed `error`   -> error.
 * - dev-seed `disabled` (prod build) -> fall through to the env-hydrated path.
 */
export function useStudioDataSource(databaseId?: string): StudioDataState {
  const seed = useDevSeed();
  const env = useEnvironment();
  const hostAnswered = useHostAnswered();
  const sandboxWorkerAllowed = useIsSandboxWorkerAllowed();
  const sandboxWorkerLive = useSandboxWorkerLive();

  const isServedSandbox = seed.status === 'disabled' && sandboxWorkerAllowed;
  let live: WorkerLivePlane | undefined;
  if (isServedSandbox) {
    live = sandboxWorkerLive;
  }

  let backend: Parameters<typeof useStudioData>[0];
  const usesHttpPersistence = isServedSandbox && !live && env.status === 'ready';
  if (usesHttpPersistence) {
    backend = env.env.persistence;
  }
  const envData = useStudioData(backend, env.status);
  const workerRoots = useWorkerRootCollections(live, databaseId);

  return useMemo<StudioDataState>(() => {
    switch (seed.status) {
      case 'ready':
        return {
          status: 'ready',
          handles: scopeHandlesForDatabase(handlesFromSeed(seed.handles), databaseId),
        };
      case 'pending':
        return { status: 'pending', handles: null };
      case 'error':
        return { status: 'error', handles: null, error: seed.error };
      case 'disabled': {
        if (!hostAnswered) {
          return { status: 'pending', handles: null };
        }
        if (live && envData.status === 'ready') {
          const targetWorkerDb = live.dbFor ? live.dbFor(databaseId) : live.db;
          const liveDb = targetWorkerDb as unknown as StudioDataHandles['firestore'];
          const scopedHandles: StudioDataHandles = {
            ...envData.handles,
            firestore: liveDb,
            adminFirestore: liveDb,
            auth: live.auth,
            storage: live.storage,
            listRootCollections: () => workerRoots,
            listSubcollections: (docPath: string) => live.listSubcollections(docPath, databaseId),
            listDocuments: (collectionPath: string) =>
              live.listDocuments(collectionPath, databaseId),
          };
          if (databaseId !== undefined && databaseId !== '' && databaseId !== '(default)') {
            scopedHandles.databaseId = databaseId;
          }
          return {
            status: 'ready',
            firestoreApi: live.firestoreApi,
            authApi: live.authApi,
            storageApi: live.storageApi,
            handles: scopedHandles,
          };
        }
        if (envData.status === 'ready') {
          return {
            ...envData,
            handles: scopeHandlesForDatabase(envData.handles, databaseId),
          };
        }
        return envData;
      }
    }
  }, [seed, hostAnswered, envData, live, workerRoots, databaseId]);
}

const EMPTY_ROOT_COLLECTIONS: string[] = [];

interface RootCollectionsStore {
  getSnapshot(): string[];
  subscribe(listener: () => void): () => void;
}

const rootStoresByPlane = new WeakMap<WorkerLivePlane, Map<string, RootCollectionsStore>>();

function normalizeDatabaseKey(databaseId: string | undefined): string {
  if (databaseId === undefined || databaseId === '' || databaseId === DEFAULT_FIRESTORE_DATABASE) {
    return DEFAULT_FIRESTORE_DATABASE;
  }
  return databaseId;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function alignAdminLens(live: WorkerLivePlane): void {
  try {
    live.setLens({ mode: 'admin' });
  } catch (error: unknown) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }
}

function createRootCollectionsStore(
  live: WorkerLivePlane,
  databaseId: string | undefined,
): RootCollectionsStore {
  let roots: string[] = EMPTY_ROOT_COLLECTIONS;
  const listeners = new Set<() => void>();
  let feedUnsub: (() => void) | null = null;
  let generation = 0;
  let inFlight = false;
  let rerunRequested = false;

  const notifyListeners = (): void => {
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) {
        listener();
      }
    }
  };

  const runFetch = (runGeneration: number): void => {
    inFlight = true;
    live
      .listRootCollections(databaseId)
      .then(
        (ids) => {
          if (runGeneration !== generation || listeners.size === 0) return;
          const next = [...ids];
          if (!sameStringArray(roots, next)) {
            roots = next;
            notifyListeners();
          }
        },
        (error: unknown) => {
          // Best-effort: retain the last known collection list across transient port errors.
          if (error instanceof Error) {
            return;
          }
        },
      )
      .finally(() => {
        if (runGeneration !== generation) return;
        inFlight = false;
        if (rerunRequested && listeners.size > 0) {
          rerunRequested = false;
          runFetch(runGeneration);
        }
      });
  };

  const requestRefresh = (runGeneration: number): void => {
    if (runGeneration !== generation || listeners.size === 0) return;
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    runFetch(runGeneration);
  };

  return {
    getSnapshot: () => roots,
    subscribe: (listener) => {
      const wasEmpty = listeners.size === 0;
      listeners.add(listener);
      if (wasEmpty) {
        generation += 1;
        const activeGeneration = generation;
        inFlight = false;
        rerunRequested = false;
        alignAdminLens(live);
        requestRefresh(activeGeneration);
        feedUnsub = live.feed.subscribe(() => {
          requestRefresh(activeGeneration);
        });
      }
      return () => {
        const removed = listeners.delete(listener);
        if (removed && listeners.size === 0) {
          generation += 1;
          inFlight = false;
          rerunRequested = false;
          roots = EMPTY_ROOT_COLLECTIONS;
          if (feedUnsub !== null) {
            feedUnsub();
            feedUnsub = null;
          }
        }
      };
    },
  };
}

function getRootCollectionsStore(
  live: WorkerLivePlane,
  databaseId: string | undefined,
): RootCollectionsStore {
  let byDb = rootStoresByPlane.get(live);
  if (byDb === undefined) {
    byDb = new Map<string, RootCollectionsStore>();
    rootStoresByPlane.set(live, byDb);
  }
  const key = normalizeDatabaseKey(databaseId);
  const existing = byDb.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const scopedDbId = key === DEFAULT_FIRESTORE_DATABASE ? undefined : key;
  const created = createRootCollectionsStore(live, scopedDbId);
  byDb.set(key, created);
  return created;
}

function noopSubscribe(): () => void {
  return () => {};
}

function getEmptyRootCollections(): string[] {
  return EMPTY_ROOT_COLLECTIONS;
}

/**
 * Shared reactive cache of the live worker's root collection ids, deduplicated
 * per `(live, databaseId)` across all `useStudioDataSource` consumers so N
 * surfaces share one `live.feed` subscription and one refresh loop.
 */
function useWorkerRootCollections(
  live: WorkerLivePlane | undefined,
  databaseId?: string,
): string[] {
  const store = useMemo(() => {
    if (live === undefined) {
      return null;
    }
    return getRootCollectionsStore(live, databaseId);
  }, [live, databaseId]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (store === null) {
        return noopSubscribe();
      }
      return store.subscribe(listener);
    },
    [store],
  );
  const getSnapshot = useCallback(() => {
    if (store === null) {
      return EMPTY_ROOT_COLLECTIONS;
    }
    return store.getSnapshot();
  }, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getEmptyRootCollections);
}
