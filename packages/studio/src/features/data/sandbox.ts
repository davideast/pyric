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
 * THE LENS (admin vs app-session)
 * -------------------------------
 * The auth lens is one knob with two positions Studio cares about here:
 *   - `app-session`: rules apply (what the running app sees), and
 *   - `admin`      : rules bypass, "edit anything" (`getAdminFirestore`).
 * In the served-app worker context the same switch is `setLens({mode:'admin'})`
 * on the worker client (see `serve/worker/client.ts`); that client routes every
 * Firestore data op through the worker host's `lensDb`, which resolves
 * `{mode:'admin'}` to exactly this `getAdminFirestore(sandbox)` handle. Studio
 * is its own Vite app (it can't import that worker-internal client as a
 * package), so it drives the *same primitive* directly: flip the lens and the
 * Firestore handle swaps between `getFirestore(sandbox)` (rules apply) and
 * `getAdminFirestore(sandbox)` (admin bypass). If a host ever exposes the worker
 * client on `window`, {@link applyWorkerLens} mirrors the choice onto it too, so
 * a future served-context embedding stays in sync: best-effort, never throws.
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

/** Which auth lens the data grids run under. */
export type DataLens = 'app-session' | 'admin';

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

/**
 * Pick the Firestore handle for a lens. `admin` returns the rules-bypass handle
 * (`getAdminFirestore`): the "edit anything" surface; `app-session` returns the
 * rules-respecting handle. This is the in-process analog of the worker client's
 * `setLens(...)` (which resolves to the same `getAdminFirestore` on the host).
 */
export function firestoreForLens(handles: StudioDataHandles, lens: DataLens): Firestore {
  return lens === 'admin' ? handles.adminFirestore : handles.firestore;
}

/**
 * Best-effort: mirror the lens onto a worker client if a host exposed one on
 * `window.__pyricWorker` (served-context embedding). Never throws; Studio's own
 * in-process handle swap is the source of truth; this only keeps a co-resident
 * worker client in sync. Calls the same `setLens({mode:'admin'|'app-session'})`
 * the worker protocol documents.
 */
export function applyWorkerLens(lens: DataLens): void {
  try {
    const w = globalThis as unknown as {
      __pyricWorker?: { setLens?: (l: { mode: string }) => void };
    };
    w.__pyricWorker?.setLens?.({ mode: lens === 'admin' ? 'admin' : 'app-session' });
  } catch {
    // A worker client may be absent (the common case); Studio's own handle
    // swap already applied the lens, so this is purely additive.
  }
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
