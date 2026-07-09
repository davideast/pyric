/**
 * The Studio-side data handle + auth-lens wiring for the cross-service
 * viewer/editor (F2).
 *
 * WHAT THIS RESOLVES
 * ------------------
 * The `@pyric/ui` grids are headless and operate against a `pyric/*` handle
 * (`Firestore` / `Auth` / `FirebaseStorage`). F2 needs two things from those
 * handles:
 *   1. a single backend the app, the agent, and Studio all share, and
 *   2. an *admin lens* so the user can "edit anything" (rules bypass).
 *
 * ALWAYS ADMIN (M2/M3)
 * --------------------
 * Studio data views read and write through the ADMIN handle
 * (`getAdminFirestore`, rules bypass) — always. "What can user X see/do" is
 * a simulation in the rules debugger, never a viewing mode, so there is no
 * lens toggle and no as-app-session read path here. The rules-respecting
 * `firestore` handle remains on the bundle for the worker/dev-seed plumbing
 * that needs both, but the data surfaces never render through it. (The
 * worker protocol's actAs/lens machinery is untouched — other consumers use
 * it; this is UI-layer policy only.)
 *
 * DURABLE STATE
 * -------------
 * The handle is an in-process `Sandbox` hydrated from the environment's durable
 * `PersistenceBackend` (the server's `--persist` channel in `local` mode). That
 * makes Studio's grids reflect the same data on disk; writes flush back through
 * the same backend. When the env is pending/errored (T3 stub), there is no
 * backend to hydrate from and the panes fall back to the honest empty state.
 */

import { useEffect, useMemo, useState } from 'react';
import { initializeApp, type PyricApp } from 'pyric/app';
import { getAdminFirestore, getFirestore, type Firestore } from 'pyric/firestore';
import { getAuth, type Auth } from 'pyric/auth';
import { getStorage, type FirebaseStorage } from 'pyric/storage';
import { initializeSandbox, type PersistenceBackend, type Sandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { FirestoreApi } from '@pyric/ui/firestore';
import type { AuthApi } from '@pyric/ui/auth';
import type { StorageApi } from '@pyric/ui/storage';

/** Stable durable-state bucket key for Studio's mirror of the sandbox. */
const PERSIST_KEY = 'pyric-studio';

/** The resolved data handles for one Studio sandbox, plus collection listing. */
export interface StudioDataHandles {
  sandbox: Sandbox;
  app: PyricApp;
  /** Rules-respecting handle (`app-session` lens). */
  firestore: Firestore;
  /** Rules-bypass handle (`admin` lens, "edit anything"). */
  adminFirestore: Firestore;
  auth: Auth;
  storage: FirebaseStorage;
  /** Root collection IDs derived from the live keyspace. */
  listRootCollections(): string[];
  /** Subcollection IDs under a document path. Sync in-process (dev-seed),
   *  async over the worker (served mode); callers await either. */
  listSubcollections(docPath: string): string[] | Promise<string[]>;
}

/** Build the handle bundle for a freshly-created sandbox. */
function makeHandles(sandbox: Sandbox): StudioDataHandles {
  const app = initializeApp({ sandbox });
  const env = getInternalEnv(sandbox);
  return {
    sandbox,
    app,
    firestore: getFirestore(sandbox),
    adminFirestore: getAdminFirestore(sandbox),
    auth: getAuth(sandbox),
    storage: getStorage(app),
    listRootCollections: () => env.listRootCollections(),
    listSubcollections: (docPath: string) => env.listSubcollections(docPath),
  };
}

export type StudioDataState =
  | { status: 'pending'; handles: null }
  | {
      status: 'ready';
      handles: StudioDataHandles;
      /**
       * The Firestore API bundle to inject (Wave 2.5b served mode). Present when
       * the handles are worker-backed, so `DataFeature` wraps the grid in a
       * `FirestoreApiProvider`. Absent for the dev-seed / in-process path, where
       * the grid's default in-process `pyric/firestore` API is correct.
       */
      firestoreApi?: FirestoreApi;
      /**
       * The Auth API bundle to inject (Wave 2.5b served mode). Present alongside
       * `firestoreApi` when worker-backed; absent for the dev-seed / in-process
       * path (the default in-process `pyric/auth` API is correct there).
       */
      authApi?: AuthApi;
      /**
       * The Storage API bundle to inject (Wave 2.5b served mode). Present
       * alongside the others when worker-backed; absent for the dev-seed /
       * in-process path.
       */
      storageApi?: StorageApi;
    }
  | { status: 'error'; handles: null; error: Error };

/**
 * Resolve the Studio data handles, hydrating from the environment's durable
 * `PersistenceBackend` when one is available. Returns a discriminated state so
 * panes render the honest empty state while the backend is unavailable, rather
 * than crashing.
 *
 * `backend` is `undefined` when the env hasn't resolved (T3 pending). In that
 * case we still build an in-memory sandbox so the grids are interactive, but
 * mark the state `pending` so the empty-state copy stays backend-aware.
 */
export function useStudioData(
  backend: PersistenceBackend | undefined,
  envStatus: 'ready' | 'pending' | 'error',
): StudioDataState {
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // One sandbox per mount; `enablePersistence` hydrates it from the backend.
  const sandbox = useMemo(() => initializeSandbox(), []);
  const handles = useMemo(() => {
    try {
      return makeHandles(sandbox);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return null;
    }
  }, [sandbox]);

  useEffect(() => {
    let cancelled = false;
    if (!backend) {
      setHydrated(false);
      return;
    }
    sandbox
      .enablePersistence({ key: PERSIST_KEY, injectedBackend: backend })
      .then(() => {
        if (!cancelled) setHydrated(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      cancelled = true;
    };
  }, [sandbox, backend]);

  if (error) return { status: 'error', handles: null, error };
  if (!handles) {
    return {
      status: 'error',
      handles: null,
      error: new Error('Studio: failed to construct the sandbox data handles.'),
    };
  }
  // Backend present + hydrated, OR env reported ready ⇒ live. Otherwise pending.
  const live = (backend != null && hydrated) || envStatus === 'ready';
  return live
    ? { status: 'ready', handles }
    : { status: 'pending', handles: null };
}
