/**
 * Studio data source: the one seam every surface reads from.
 *
 * Studio has two ways to get live `pyric/*` handles + the event stream:
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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  sandbox as firestoreSandbox,
  doc as inProcessDoc,
  setDoc as inProcessSetDoc,
  collection as inProcessCollection,
  query as inProcessQuery,
  getDocs as inProcessGetDocs,
  deleteDoc as inProcessDeleteDoc,
} from 'pyric/firestore';
import { sandbox as authSandbox, type CreateUserRequest } from 'pyric/auth';
import { setRules as workerSetRules } from 'pyric-tools/serve/worker';
import type {
  RequestEvent,
  SandboxEvent,
  SandboxOperationEvent,
  SandboxSnapshot,
} from 'pyric/sandbox';
import type { TrafficEvent } from '@pyric/ui/traffic';
import { useDevSeed } from '../dev/DevSeedProvider.js';
import { useEnvironment } from './environment.js';
import type { WorkerLivePlane } from '../env.js';
import {
  useStudioData,
  type StudioDataHandles,
  type StudioDataState,
} from '../features/data/sandbox.js';
import {
  emptyEventFeed,
  feedFromSandboxLike,
  type EventFeed,
} from '../features/action-center/feed.js';
import {
  selectDenials,
  type Denial,
} from '../features/rules-debug/model.js';

/** Lift the dev-seed's `SeededHandles` to the richer `StudioDataHandles` the F2
 *  panes expect (the only delta is the two keyspace-listing helpers, which come
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

/**
 * An {@link EventFeed} for the Action Center, dev-seed first. The seeded sandbox
 * satisfies the feed shape directly (`history()` + `onEvent`); otherwise the
 * live SharedWorker feed (`env.live.feed`) when `pyric dev --ui` is reachable,
 * and the empty feed as the final fallback (SSR / no worker / tests).
 */
export function useStudioEventFeed(): EventFeed {
  const seed = useDevSeed();
  const env = useEnvironment();
  const liveFeed = env.status === 'ready' ? env.env.live?.feed : undefined;
  return useMemo<EventFeed>(
    () =>
      seed.status === 'ready'
        ? feedFromSandboxLike(seed.handles.sandbox)
        : liveFeed ?? emptyEventFeed(),
    [seed, liveFeed],
  );
}

/**
 * The unified `SandboxEvent` array every activity surface (Session, Traffic)
 * reads, dev-seed first. The seed's `events` array is already reactive; in
 * served mode it accumulates the live worker feed (the backlog seeds it, then
 * each live event appends). Empty when neither source is present.
 *
 * The feed delivers its history batch to the FIRST subscriber (see
 * `workerEventFeed`), so a fresh subscription receives the backlog even though
 * `history()` reads empty at subscribe time: hence we seed from `history()` AND
 * accumulate via `subscribe`, which folds each event exactly once.
 */
export function useStudioEvents(): readonly SandboxEvent[] {
  const seed = useDevSeed();
  const env = useEnvironment();
  const liveFeed = env.status === 'ready' ? env.env.live?.feed : undefined;
  const seedReady = seed.status === 'ready';

  const [liveEvents, setLiveEvents] = useState<readonly SandboxEvent[]>([]);
  useEffect(() => {
    if (seedReady || !liveFeed) {
      setLiveEvents([]);
      return;
    }
    setLiveEvents(liveFeed.history());
    const unsub = liveFeed.subscribe((event) =>
      setLiveEvents((prev) => [...prev, event]),
    );
    return unsub;
  }, [seedReady, liveFeed]);

  return seedReady ? seed.events : liveEvents;
}

function isTrafficEvent(e: SandboxEvent): e is RequestEvent | SandboxOperationEvent {
  return e.kind === 'request' || e.kind === 'operation';
}

function toTrafficEvent(e: RequestEvent | SandboxOperationEvent): TrafficEvent {
  if (e.kind === 'request') {
    return e as unknown as TrafficEvent;
  }
  return {
    kind: 'operation',
    service: e.service,
    id: e.id,
    at: e.at,
    durationMs: e.durationMs,
    method: e.method,
    path: e.path ?? '(service)',
    auth: e.auth,
    result: e.result,
    reasons: e.reasons ?? [],
    request: e.request,
    resourceBefore: e.resourceBefore,
    resourceAfter: e.resourceAfter,
    origin: e.origin,
    groupId: e.groupId,
    groupKind: e.groupKind,
    triggeredBy: e.triggeredBy,
  };
}

/**
 * The traffic feed. Firestore still emits legacy `request` events; RTDB and
 * other services can emit canonical `operation` events. Adapt both into the
 * headless `@pyric/ui/traffic` shape.
 */
export function useStudioTraffic(): TrafficEvent[] {
  const events = useStudioEvents();
  return useMemo<TrafficEvent[]>(
    () => events.filter(isTrafficEvent).map(toTrafficEvent),
    [events],
  );
}

/** The denied ops (rules-failure debugging), derived from the live stream. */
export function useStudioDenials(): Denial[] {
  const events = useStudioEvents();
  return useMemo<Denial[]>(() => selectDenials(events), [events]);
}

/**
 * A getter for the current sandbox snapshot (Pyric Studio rules re-run): the
 * dev-seed's in-process sandbox in review, or the live worker's snapshot under
 * `pyric dev --ui`. Studio forks the result to test a denied op against edited
 * rules / re-issue it as the attempting user, all on a throwaway branch (no live
 * mutation). Resolves null when neither source is present (the re-run UI stays
 * off rather than guessing).
 */
/**
 * Deploy a ruleset to the live sandbox (Pyric Studio rules-fix "Apply"): the
 * dev-seed's in-process sandbox in review, or the live worker under
 * `pyric dev --ui`. The same `setRules` op the served app uses. Throws when
 * neither source is present.
 */
export function useStudioSetRules(): (source: string) => Promise<void> {
  const seed = useDevSeed();
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const seedFirestore = seed.status === 'ready' ? seed.handles.firestore : null;
  return useCallback(
    async (source: string) => {
      if (seedFirestore) {
        firestoreSandbox.setRules(seedFirestore, source);
        return;
      }
      if (live) {
        await workerSetRules(live.db, source);
        return;
      }
      throw new Error('No sandbox available to deploy rules to.');
    },
    [seedFirestore, live],
  );
}

/** One generated seed document. */
export interface SeedOp {
  path: string;
  data: Record<string, unknown>;
}

/**
 * Apply generated seed documents to the live sandbox as ADMIN (rules bypass),
 * for the NL-seed assist. Routes through the same handle + Firestore API the data
 * grids use: the in-process `pyric/firestore` for dev-seed, the worker bundle in
 * served mode. Returns per-op errors so the caller can report partial failures.
 */
export function useStudioSeed(): (ops: readonly SeedOp[]) => Promise<{ written: number; errors: string[] }> {
  const data = useStudioDataSource();
  return useCallback(
    async (ops: readonly SeedOp[]) => {
      if (data.status !== 'ready') throw new Error('No sandbox available to seed.');
      const adminDb = data.handles.adminFirestore as unknown as Parameters<typeof inProcessDoc>[0];
      const docFn = (data.firestoreApi?.doc ?? inProcessDoc) as typeof inProcessDoc;
      const setDocFn = (data.firestoreApi?.setDoc ?? inProcessSetDoc) as typeof inProcessSetDoc;
      let written = 0;
      const errors: string[] = [];
      for (const op of ops) {
        try {
          await setDocFn(docFn(adminDb, op.path), op.data);
          written++;
        } catch (e) {
          errors.push(`${op.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { written, errors };
    },
    [data],
  );
}

/** One staged auth-user creation. The `{ request }` wrapper leaves room for
 *  update/delete kinds when the proposal auth-op capture lands (next step). */
export interface AuthCreateOp {
  request: CreateUserRequest;
}

/**
 * Create auth users on the live sandbox as ADMIN, mirroring {@link useStudioSeed}.
 * Routes through the same auth handle + API the data surfaces use: in-process
 * `pyric/auth` for dev-seed, the worker bundle in served mode (so it `await`s,
 * since the worker variant is async). Returns per-op errors so the caller can
 * report partial failures (e.g. `auth/uid-already-exists` at apply time).
 */
export function useStudioSeedAuth(): (
  ops: readonly AuthCreateOp[],
) => Promise<{ created: number; errors: string[] }> {
  const data = useStudioDataSource();
  return useCallback(
    async (ops: readonly AuthCreateOp[]) => {
      if (data.status !== 'ready') throw new Error('No sandbox available to seed auth.');
      const authHandle = data.handles.auth as unknown as Parameters<typeof authSandbox.createUser>[0];
      const createUserFn = (data.authApi?.createUser ??
        authSandbox.createUser) as typeof authSandbox.createUser;
      let created = 0;
      const errors: string[] = [];
      for (const op of ops) {
        try {
          await createUserFn(authHandle, op.request);
          created++;
        } catch (e) {
          const who = op.request.uid ?? op.request.email ?? '<auto>';
          errors.push(`${who}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { created, errors };
    },
    [data],
  );
}

/**
 * Clear the sandbox: delete every Firestore document (root collections +
 * recursive subcollections, via the admin handle) and clear all auth users.
 * Subcollection refs are built from the parent doc ref (not multi-segment
 * collection paths), so it works in both in-process and served modes.
 */
export function useStudioClear(): () => Promise<{ cleared: number; errors: string[] }> {
  const data = useStudioDataSource();
  return useCallback(async () => {
    if (data.status !== 'ready') throw new Error('No sandbox to clear.');
    const adminDb = data.handles.adminFirestore as unknown as Parameters<typeof inProcessDoc>[0];
    const docFn = (data.firestoreApi?.doc ?? inProcessDoc) as typeof inProcessDoc;
    const collectionFn = (data.firestoreApi?.collection ?? inProcessCollection) as typeof inProcessCollection;
    const queryFn = (data.firestoreApi?.query ?? inProcessQuery) as typeof inProcessQuery;
    const getDocsFn = (data.firestoreApi?.getDocs ?? inProcessGetDocs) as typeof inProcessGetDocs;
    const deleteDocFn = (data.firestoreApi?.deleteDoc ?? inProcessDeleteDoc) as typeof inProcessDeleteDoc;
    const errors: string[] = [];
    const docPaths: string[] = [];

    // Collect every doc path, recursing subcollections (parent-ref form).
    const collectFrom = async (collRef: unknown, collPath: string): Promise<void> => {
      try {
        const snap = await getDocsFn(queryFn(collRef as never));
        for (const d of snap.docs) {
          const docPath = `${collPath}/${d.id}`;
          docPaths.push(docPath);
          const subIds = await data.handles.listSubcollections(docPath);
          for (const sub of subIds) {
            await collectFrom(collectionFn(docFn(adminDb, docPath) as never, sub), `${docPath}/${sub}`);
          }
        }
      } catch (e) {
        errors.push(`list ${collPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    for (const collId of data.handles.listRootCollections()) {
      await collectFrom(collectionFn(adminDb as never, collId), collId);
    }

    let cleared = 0;
    for (const path of docPaths) {
      try {
        await deleteDocFn(docFn(adminDb, path));
        cleared += 1;
      } catch (e) {
        errors.push(`delete ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Clear auth users (one shot). clearUsers takes the auth handle (Pick over
    // the sandbox ops); data.handles.auth is the worker handle in served mode.
    try {
      const clearUsersFn = data.authApi?.clearUsers ?? authSandbox.clearUsers;
      clearUsersFn(data.handles.auth as Parameters<typeof authSandbox.clearUsers>[0]);
    } catch (e) {
      errors.push(`auth: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { cleared, errors };
  }, [data]);
}

/**
 * Reset the session: clear the sandbox, then re-apply the seed. Dev-seed mode
 * re-runs the in-process fixture; served mode re-applies `/__pyric/init.json`.
 */
export function useStudioReset(): () => Promise<{ cleared: number; errors: string[] }> {
  const clear = useStudioClear();
  const seedDocs = useStudioSeed();
  const seedAuthUsers = useStudioSeedAuth();
  const dev = useDevSeed();
  return useCallback(async () => {
    const result = await clear();
    if (dev.status === 'ready') {
      const { applySeed } = await import('../dev/seed.js');
      await applySeed(dev.handles);
    } else {
      try {
        const payload = await fetch('/__pyric/init.json').then((r) => (r.ok ? r.json() : null));
        const seedMap = payload?.seed as Record<string, Record<string, unknown>> | undefined;
        if (seedMap) {
          await seedDocs(Object.entries(seedMap).map(([path, docData]) => ({ path, data: docData })));
        }
        const authUsers = payload?.authUsers as CreateUserRequest[] | undefined;
        if (Array.isArray(authUsers)) {
          await seedAuthUsers(authUsers.map((request) => ({ request })));
        }
      } catch (e) {
        result.errors.push(`reseed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }, [clear, seedDocs, seedAuthUsers, dev]);
}

export function useStudioSnapshot(): () => Promise<SandboxSnapshot | null> {
  const seed = useDevSeed();
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const seedSandbox = seed.status === 'ready' ? seed.handles.sandbox : null;
  return useCallback(async () => {
    if (seedSandbox) return seedSandbox.snapshot();
    if (live) return live.getSnapshot();
    return null;
  }, [seedSandbox, live]);
}

/**
 * The live sandbox's stable instance id (Phase 1: instance identity). Empty in
 * dev-seed / review (no live worker). Studio renders it as a slug so a user can
 * tell WHICH sandbox instance they're looking at — the same `localhost:<port>`
 * in another browser profile is a separate instance.
 */
export function useSandboxInstanceId(): string {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const [id, setId] = useState('');
  useEffect(() => {
    if (!live) {
      setId('');
      return;
    }
    let cancelled = false;
    void live.instanceId().then((v) => {
      if (!cancelled) setId(v);
    });
    return () => {
      cancelled = true;
    };
  }, [live]);
  return id;
}

/**
 * Phase 2 (transfer): export the live sandbox's full state as a portable bundle
 * string. Returns null in dev-seed / review (no live worker).
 */
export function useStudioExport(): () => Promise<string | null> {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  return useCallback(async () => {
    if (!live) return null;
    return live.exportState();
  }, [live]);
}

/**
 * Phase 2 (clobber): replace the live sandbox's ENTIRE state with `bundle`.
 * Returns false in dev-seed / review (no live worker to clobber).
 */
export function useStudioImport(): (bundle: string) => Promise<boolean> {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  return useCallback(async (bundle: string) => {
    if (!live) return false;
    await live.importState(bundle);
    return true;
  }, [live]);
}

/** Phase 3 (named branches): saved branches + save/switch/delete. */
export interface StudioBranches {
  branches: string[];
  save(name: string): Promise<void>;
  switchTo(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * The live sandbox's named branches and their mutations. The list refreshes
 * after each save/delete; empty in dev-seed / review (no live worker).
 */
export function useStudioBranches(): StudioBranches {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const [branches, setBranches] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    setBranches(live ? await live.listBranches() : []);
  }, [live]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const save = useCallback(
    async (name: string) => {
      if (!live) return;
      await live.saveBranch(name);
      await refresh();
    },
    [live, refresh],
  );
  const switchTo = useCallback(
    async (name: string) => {
      if (live) await live.switchBranch(name);
    },
    [live],
  );
  const remove = useCallback(
    async (name: string) => {
      if (!live) return;
      await live.deleteBranch(name);
      await refresh();
    },
    [live, refresh],
  );
  return { branches, save, switchTo, remove };
}

/**
 * The deployed Firestore rules text the denial inspector traces against,
 * dev-seed first. In served mode the rules the server deployed ride
 * `/__pyric/init.json` (the page init payload), so a one-shot same-origin fetch
 * reads them without a worker round-trip. Empty until resolved (the inspector
 * still shows the denial's path/method/auth; the trace fills in once present).
 */
export function useStudioRulesSource(): string {
  const seed = useDevSeed();
  const seedReady = seed.status === 'ready';
  const [servedRules, setServedRules] = useState('');

  useEffect(() => {
    if (seedReady) return;
    let alive = true;
    fetch('/__pyric/init.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { rules?: string | null } | null) => {
        if (alive && payload && typeof payload.rules === 'string') {
          setServedRules(payload.rules);
        }
      })
      .catch(() => {
        /* best-effort: no text, the inspector still renders the denial. */
      });
    return () => {
      alive = false;
    };
  }, [seedReady]);

  return useMemo<string>(() => {
    if (seed.status !== 'ready') return servedRules;
    try {
      return getInternalEnv(seed.handles.sandbox).getRules();
    } catch {
      return '';
    }
  }, [seed, servedRules]);
}
