/**
 * Studio's Live-mode "Observed Session Data" hook and its explicit opt-in
 * seeding client (`docs/research/live-mode.md` §§ 4, 6, 9):
 *
 * - Reads partial, session-observed Firestore documents and RTDB trees from
 *   the host's in-memory `GET /__pyric/live/session-data` endpoint.
 * - Mirrors observed Firestore documents into the ephemeral, purely in-memory
 *   sandbox of `observed-session-mirror.ts`; every mutation is refused with
 *   `PYRIC_LIVE_REFUSED`.
 * - Persisting observed session data into `.pyric/state/hosted` happens ONLY
 *   when the developer explicitly confirms `seedLocalSandbox(mode)`, which
 *   sends `POST /__pyric/live/seed-sandbox` with `{ confirm: true, mode }`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteDoc, doc, setDoc } from 'pyric/firestore';
import type { LiveSeedMode, LiveSeedSandboxResult } from '@pyric/cli/vite/internal/supplied-rows';
import type { FirestoreApi } from '@pyric/ui/firestore';
import { normalizeRtdbSnapshotValue, rtdbValueAt, type RtdbApi } from '@pyric/ui/rtdb';
import type { StorageApi } from '@pyric/ui/storage';
import type { FirebaseStorage } from 'pyric/storage';
import type { StudioDataHandles } from '../features/data/sandbox.js';
import {
  createEphemeralHandles,
  createLiveRefusedError,
  readOnlyFirestoreApi,
  rehydrateObservedFirestoreDoc,
} from './observed-session-mirror.js';
import {
  createObservedStorageHandle,
  createReadOnlyStorageApi,
  selectActiveStorageBucket,
  summarizeObservedStorageBuckets,
  type ObservedStorageBucketSnapshot,
  type ObservedStorageBucketSummary,
} from './observed-storage-mirror.js';
import {
  EMPTY_OBSERVED_SNAPSHOT,
  buildObservedSeedPayload,
  isPlainRecord,
  parseObservedSessionSnapshot,
  type ObservedSessionDataSnapshot,
} from './observed-session-parse.js';
import { studioSessionHeaders, useServeInit, type ServeInitDatabaseInstances } from './serve-init.js';
import { useStudioEventFeed } from './studio-events.js';

// The host routes, `LIVE_SESSION_DATA_PATH` and `LIVE_SEED_SANDBOX_PATH` in
// `@pyric/cli`. Restated here because no browser-safe `@pyric/cli` entry
// exports them; the package entry that re-exports the wire types is Node-only.
const LIVE_SESSION_DATA_URL = '/__pyric/live/session-data';
const LIVE_SEED_SANDBOX_URL = '/__pyric/live/seed-sandbox';

export type { LiveSeedMode, LiveSeedSandboxResult };

export interface ObservedRtdbInstanceSummary {
  readonly instance: string;
  readonly observed: boolean;
  readonly isDefault: boolean;
  readonly topLevelKeys: number;
  readonly byteEstimate: number;
}

export interface ObservedSessionViewState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly snapshot: ObservedSessionDataSnapshot;
  readonly handles: StudioDataHandles;
  readonly firestoreApi: FirestoreApi;
  readonly rtdbApi: RtdbApi;
  readonly rtdbInstances: readonly string[];
  readonly rtdbInstanceSummaries: readonly ObservedRtdbInstanceSummary[];
  readonly activeRtdbInstance: string;
  readonly setActiveRtdbInstance: (instance: string) => void;
  readonly hasObservedRtdb: boolean;
  readonly storageApi: StorageApi;
  readonly storageHandle: FirebaseStorage;
  readonly storageBucketSummaries: readonly ObservedStorageBucketSummary[];
  readonly activeStorageBucket: string;
  readonly setActiveStorageBucket: (bucket: string) => void;
  readonly activeStorageCatalog: ObservedStorageBucketSnapshot | undefined;
  readonly hasObservedStorage: boolean;
  readonly refresh: () => Promise<void>;
  readonly seedLocalSandbox: (mode: LiveSeedMode) => Promise<LiveSeedSandboxResult>;
  readonly exportSeedJson: () => string;
  readonly downloadSeedJson: () => void;
}

interface ConfiguredRtdbInstances {
  readonly defaultInstance: string | null;
  readonly names: readonly string[];
}

const NO_CONFIGURED_INSTANCES: ConfiguredRtdbInstances = { defaultInstance: null, names: [] };

function configuredRtdbInstances(
  dbInstances: ServeInitDatabaseInstances | null | undefined,
): ConfiguredRtdbInstances {
  if (!dbInstances) return NO_CONFIGURED_INSTANCES;
  let defaultInstance: string | null = null;
  if (typeof dbInstances.defaultInstance === 'string' && dbInstances.defaultInstance.length > 0) {
    defaultInstance = dbInstances.defaultInstance;
  }
  const names = isPlainRecord(dbInstances.rules) ? Object.keys(dbInstances.rules) : [];
  return { defaultInstance, names };
}

function topLevelKeyCount(tree: unknown): number {
  if (isPlainRecord(tree)) return Object.keys(tree).length;
  if (Array.isArray(tree)) return tree.filter((item) => item !== null && item !== undefined).length;
  return tree !== null && tree !== undefined ? 1 : 0;
}

function estimateJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return 0;
  if (typeof TextEncoder === 'undefined') return json.length;
  return new TextEncoder().encode(json).length;
}

export function useObservedSessionData(
  enabled: boolean,
  fallbackProjectId?: string,
): ObservedSessionViewState {
  const feed = useStudioEventFeed();
  const initState = useServeInit();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    enabled ? 'loading' : 'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ObservedSessionDataSnapshot>(EMPTY_OBSERVED_SNAPSHOT);
  const [selectedRtdbInstance, setSelectedRtdbInstance] = useState<string | null>(null);
  const [selectedStorageBucket, setSelectedStorageBucket] = useState<string | null>(null);
  const [syncGeneration, setSyncGeneration] = useState(0);

  // Purely in-memory sandbox mirror for Firestore reads/queries/phantoms.
  const baseHandles = useMemo(() => createEphemeralHandles(), []);
  const appliedRevisionRef = useRef<number>(-1);
  const appliedDocsRef = useRef<Set<string>>(new Set());
  const syncChainRef = useRef<Promise<void>>(Promise.resolve());

  const fetchSnapshot = useCallback(async () => {
    if (typeof fetch === 'undefined') return;
    try {
      const headers = studioSessionHeaders();
      const response = await fetch(LIVE_SESSION_DATA_URL, {
        cache: 'no-store',
        ...(headers ? { headers } : {}),
      });
      if (!response.ok) {
        throw new Error(`Observed session endpoint answered ${response.status}.`);
      }
      const parsed = parseObservedSessionSnapshot(await response.json());
      setSnapshot((prev) => {
        // Keep the same object for an unchanged revision so dependent memos stay stable.
        if (prev.revision === parsed.revision && status === 'ready') return prev;
        return parsed;
      });
      setError(null);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [status]);

  // Initial fetch + coalesced event-driven refetch when Live traffic advances.
  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runFetch = () => {
      if (!alive) return;
      void fetchSnapshot();
    };

    runFetch();
    const unsubscribe = feed.subscribe(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        runFetch();
      }, 25);
    });

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, feed, fetchSnapshot]);

  // Sync observed Firestore documents into the ephemeral in-memory sandbox.
  useEffect(() => {
    if (!enabled) return;
    if (snapshot.revision === appliedRevisionRef.current) return;
    const targetRevision = snapshot.revision;
    const nextDocs = snapshot.firestore;

    syncChainRef.current = syncChainRef.current.then(async () => {
      const adminDb = baseHandles.adminFirestore;
      const nextPaths = new Set(Object.keys(nextDocs));
      for (const oldPath of appliedDocsRef.current) {
        if (!nextPaths.has(oldPath)) {
          await deleteDoc(doc(adminDb, oldPath));
        }
      }
      for (const [docPath, rawDoc] of Object.entries(nextDocs)) {
        await setDoc(doc(adminDb, docPath), rehydrateObservedFirestoreDoc(adminDb, rawDoc));
      }
      appliedDocsRef.current = nextPaths;
      appliedRevisionRef.current = targetRevision;
      setSyncGeneration((gen) => gen + 1);
    });
  }, [enabled, snapshot, baseHandles]);

  const handles = useMemo<StudioDataHandles>(
    () => ({
      ...baseHandles,
      listRootCollections: () => baseHandles.listRootCollections(),
      listSubcollections: (docPath: string) => baseHandles.listSubcollections(docPath),
      listDocuments: (collectionPath: string) => baseHandles.listDocuments(collectionPath),
    }),
    // `syncGeneration` triggers re-evaluation of `listRootCollections()` after async sync completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseHandles, syncGeneration],
  );

  const configuredInstances = useMemo(() => {
    if (initState.status !== 'ready') return NO_CONFIGURED_INSTANCES;
    return configuredRtdbInstances(initState.payload.databaseInstances);
  }, [initState]);

  const rtdbInstanceSummaries = useMemo<readonly ObservedRtdbInstanceSummary[]>(() => {
    const observedNames = Object.keys(snapshot.rtdb);
    const observedSet = new Set(observedNames);
    const allNames = Array.from(new Set([...observedNames, ...configuredInstances.names]));
    const defaultName = snapshot.defaultRtdbInstance ?? configuredInstances.defaultInstance;
    allNames.sort((a, b) => {
      if (a === defaultName && b !== defaultName) return -1;
      if (b === defaultName && a !== defaultName) return 1;
      const aObs = observedSet.has(a);
      const bObs = observedSet.has(b);
      if (aObs !== bObs) return aObs ? -1 : 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    return allNames.map((instance) => {
      const observed = observedSet.has(instance);
      const tree = observed ? snapshot.rtdb[instance] : undefined;
      return {
        instance,
        observed,
        isDefault: instance === defaultName,
        topLevelKeys: observed ? topLevelKeyCount(tree) : 0,
        byteEstimate: observed ? estimateJsonBytes(tree) : 0,
      };
    });
  }, [snapshot.rtdb, snapshot.defaultRtdbInstance, configuredInstances]);

  const rtdbInstances = useMemo(
    () => rtdbInstanceSummaries.map((item) => item.instance),
    [rtdbInstanceSummaries],
  );

  const activeRtdbInstance = useMemo(() => {
    const observedNames = Object.keys(snapshot.rtdb);
    const defaultName = snapshot.defaultRtdbInstance ?? configuredInstances.defaultInstance;
    if (selectedRtdbInstance && rtdbInstances.includes(selectedRtdbInstance)) {
      return selectedRtdbInstance;
    }
    if (defaultName && observedNames.includes(defaultName)) {
      return defaultName;
    }
    const firstObserved = rtdbInstanceSummaries.find((item) => item.observed)?.instance;
    if (firstObserved) {
      return firstObserved;
    }
    if (defaultName && rtdbInstances.includes(defaultName)) {
      return defaultName;
    }
    if (rtdbInstances.length > 0) {
      return rtdbInstances[0]!;
    }
    if (defaultName) {
      return defaultName;
    }
    const proj = snapshot.projectId || fallbackProjectId;
    return proj ? `${proj}-default-rtdb` : 'observed-rtdb';
  }, [
    selectedRtdbInstance,
    rtdbInstances,
    rtdbInstanceSummaries,
    snapshot.rtdb,
    snapshot.defaultRtdbInstance,
    configuredInstances.defaultInstance,
    snapshot.projectId,
    fallbackProjectId,
  ]);

  const activeRtdbTree = useMemo(
    () => normalizeRtdbSnapshotValue(snapshot.rtdb[activeRtdbInstance] ?? null),
    [snapshot.rtdb, activeRtdbInstance],
  );

  const latestRtdbTreeRef = useRef<unknown>(activeRtdbTree);
  const rtdbSubscribersRef = useRef<Set<() => void>>(new Set());

  useEffect(() => {
    latestRtdbTreeRef.current = activeRtdbTree;
    for (const notify of rtdbSubscribersRef.current) {
      notify();
    }
  }, [activeRtdbTree]);

  const rtdbApi = useMemo<RtdbApi>(
    () => ({
      set: () => Promise.reject(createLiveRefusedError()),
      remove: () => Promise.reject(createLiveRefusedError()),
      subscribeValue(path, next) {
        const deliver = () => {
          next(rtdbValueAt(latestRtdbTreeRef.current, path));
        };
        rtdbSubscribersRef.current.add(deliver);
        deliver();
        return () => {
          rtdbSubscribersRef.current.delete(deliver);
        };
      },
    }),
    [],
  );

  const storageBucketSummaries = useMemo(
    () => summarizeObservedStorageBuckets(snapshot, fallbackProjectId),
    [snapshot, fallbackProjectId],
  );
  const activeStorageBucket = useMemo(
    () => selectActiveStorageBucket(storageBucketSummaries, selectedStorageBucket),
    [storageBucketSummaries, selectedStorageBucket],
  );
  const activeStorageCatalog = snapshot.storage?.[activeStorageBucket];
  const latestStorageViewRef = useRef({ bucket: activeStorageBucket, catalog: activeStorageCatalog });
  latestStorageViewRef.current = { bucket: activeStorageBucket, catalog: activeStorageCatalog };
  const storageApi = useMemo(
    () => createReadOnlyStorageApi(() => latestStorageViewRef.current),
    [],
  );
  const storageHandle = useMemo(
    () => createObservedStorageHandle(activeStorageBucket, snapshot.revision),
    [activeStorageBucket, snapshot.revision],
  );

  const seedLocalSandbox = useCallback(
    async (mode: LiveSeedMode): Promise<LiveSeedSandboxResult> => {
      const response = await fetch(LIVE_SEED_SANDBOX_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(studioSessionHeaders() ?? {}) },
        body: JSON.stringify({ confirm: true, mode }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        mode?: LiveSeedMode;
        seededFirestoreDocs?: number;
        seededRtdbInstances?: string[];
        revision?: number;
        error?: string;
      };
      if (!response.ok || body.ok !== true) {
        throw new Error(body.error ?? `Failed to seed local sandbox (HTTP ${response.status}).`);
      }
      return {
        ok: true,
        mode: body.mode === 'replace' ? 'replace' : 'merge',
        seededFirestoreDocs: body.seededFirestoreDocs ?? 0,
        seededRtdbInstances: body.seededRtdbInstances ?? [],
        revision: body.revision ?? snapshot.revision,
      };
    },
    [snapshot.revision],
  );

  const exportSeedJson = useCallback(
    () => JSON.stringify(buildObservedSeedPayload(snapshot, activeRtdbInstance), null, 2) + '\n',
    [snapshot, activeRtdbInstance],
  );

  const downloadSeedJson = useCallback(() => {
    const json = exportSeedJson();
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pyric-observed-seed.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [exportSeedJson]);

  return {
    status,
    error,
    snapshot,
    handles,
    firestoreApi: readOnlyFirestoreApi,
    rtdbApi,
    rtdbInstances,
    rtdbInstanceSummaries,
    activeRtdbInstance,
    setActiveRtdbInstance: setSelectedRtdbInstance,
    hasObservedRtdb: activeRtdbTree !== null,
    storageApi,
    storageHandle,
    storageBucketSummaries,
    activeStorageBucket,
    setActiveStorageBucket: setSelectedStorageBucket,
    activeStorageCatalog,
    hasObservedStorage: activeStorageCatalog !== undefined,
    refresh: fetchSnapshot,
    seedLocalSandbox,
    exportSeedJson,
    downloadSeedJson,
  };
}
