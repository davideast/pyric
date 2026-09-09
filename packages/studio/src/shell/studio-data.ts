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
import type { WorkerLivePlane } from '../env.js';
import {
  listDocumentsForBrowse,
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
export function useStudioDataSource(): StudioDataState {
  const seed = useDevSeed();
  const env = useEnvironment();

  // Env path always runs (rules of hooks); only consulted when the seed is off.
  const backend = env.status === 'ready' ? env.env.persistence : undefined;
  const envData = useStudioData(backend, env.status);

  // The live SharedWorker plane (served mode). When present, Studio's Firestore
  // grid reads the SAME worker sandbox the app + agent use (Wave 2.5b), not the
  // separate HTTP-hydrated mirror. Null in dev-seed / no-SharedWorker.
  const live = env.status === 'ready' ? env.env.live : undefined;
  const workerRoots = useWorkerRootCollections(live);

  return useMemo<StudioDataState>(() => {
    switch (seed.status) {
      case 'ready':
        return { status: 'ready', handles: handlesFromSeed(seed.handles) };
      case 'pending':
        return { status: 'pending', handles: null };
      case 'error':
        return { status: 'error', handles: null, error: seed.error };
      case 'disabled': {
        // Served mode: route Firestore (data ops + collection browse) to the
        // live worker when a SharedWorker is reachable. Auth/Storage stay on the
        // in-process env handles (empty in served mode) until M-B/M-C, which
        // keeps DataFeature's eager useAuthUsers safe.
        if (live && envData.status === 'ready') {
          const liveDb = live.db as unknown as StudioDataHandles['firestore'];
          return {
            status: 'ready',
            firestoreApi: live.firestoreApi,
            authApi: live.authApi,
            storageApi: live.storageApi,
            handles: {
              ...envData.handles,
              firestore: liveDb,
              adminFirestore: liveDb,
              auth: live.auth,
              storage: live.storage,
              listRootCollections: () => workerRoots,
              listSubcollections: (docPath: string) => live.listSubcollections(docPath),
              listDocuments: (collectionPath: string) => live.listDocuments(collectionPath),
            },
          };
        }
        return envData;
      }
    }
  }, [seed, envData, live, workerRoots]);
}

/**
 * Reactive cache of the live worker's root collection ids. Fetches on mount and
 * refetches on every worker event (so a write that materialises a new
 * collection shows up live), and aligns the worker's default lens with Studio's
 * admin default. Empty array when there is no live plane.
 */
function useWorkerRootCollections(live: WorkerLivePlane | undefined): string[] {
  const [roots, setRoots] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!live) {
      setRoots([]);
      return;
    }
    let alive = true;
    const refresh = () => {
      live
        .listRootCollections()
        .then((ids) => {
          if (alive) setRoots(ids);
        })
        .catch(() => {
          /* best-effort: keep the last known list */
        });
    };
    // Admin lens so browse + reads bypass rules (edit-anything), matching the
    // dev-seed default (navigation.tsx defaults the lens to 'admin').
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
  }, [live]);
  return roots as string[];
}
