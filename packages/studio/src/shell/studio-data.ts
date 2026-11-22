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

import { useEffect, useMemo, useState } from 'react';
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
 * - dev-seed `ready`   → live handles built from the seeded sandbox.
 * - dev-seed `pending` → pending (seeding the in-page fixture).
 * - dev-seed `error`   → error.
 * - dev-seed `disabled` (prod build) → fall through to the env-hydrated path.
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

/**
 * Reactive cache of the live worker's root collection ids. Fetches on mount and
 * refetches on every worker event (so a write that materialises a new
 * collection shows up live; the plane coalesces the requests, so a history
 * batch of any length costs at most two), and aligns the worker's default lens with Studio's
 * admin default. Empty array when there is no live plane.
 */
function useWorkerRootCollections(
  live: WorkerLivePlane | undefined,
  databaseId?: string,
): string[] {
  const [roots, setRoots] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!live) {
      setRoots([]);
      return;
    }
    let alive = true;
    const refresh = () => {
      live
        .listRootCollections(databaseId)
        .then((ids) => {
          if (alive) setRoots(ids);
        })
        .catch(() => {
          /* best-effort: keep the last known list */
        });
    };
    try {
      live.setLens({ mode: 'admin' });
    } catch {
      /* best-effort */
    }
    refresh();
    const unsub = live.feed.subscribe(() => refresh());
    return () => {
      alive = false;
      unsub();
    };
  }, [live, databaseId]);
  return roots as string[];
}
