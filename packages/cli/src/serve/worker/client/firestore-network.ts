/**
 * Per-ClientPort Firestore network toggle (`disableNetwork`, `enableNetwork`,
 * `waitForPendingWrites`), warmed-path cache (#1355), and offline write queue
 * + listener suspension/resumption (FW-17, FS-143) for SharedWorker & Node host.
 */
import type { SerializedDocData, TargetDescriptor } from '../protocol.js';
import { getLens, subscribeLens } from './core.js';
import type { ClientDb, ClientPort } from './handles.js';
import type { RawDocResult, RawQueryResult } from './snapshots.js';
import {
  projectWorkerOfflineDoc,
  projectWorkerOfflineQuery,
  targetMatchesPath,
  type WorkerOfflineMutation,
} from './firestore-offline-projection.js';
import {
  assertWorkerFirestoreActive,
  markWorkerHandleStarted,
  markWorkerPathCached,
  registerPortTerminationReset,
  unmarkWorkerPathCached,
} from './firestore-lifecycle.js';

export type { WorkerOfflineMutation };

export interface WorkerManagedFirestoreListener {
  readonly target: TargetDescriptor;
  hasDelivered(): boolean;
  suspendFromHost(): void;
  resumeOnHost(): void;
  deliverOfflineWire(wire: RawDocResult | RawQueryResult): void;
}

interface PendingPortWrite {
  readonly promise: Promise<unknown>;
  flush(): Promise<void>;
}

interface LensWarmCache {
  readonly baseDocs: Map<string, SerializedDocData | null>;
  readonly warmExistingPaths: Set<string>;
}

interface PortFirestoreState {
  networkEnabled: boolean;
  nextStageId: number;
  readonly cachesByLens: Map<string, LensWarmCache>;
  readonly staged: Array<{ readonly id: number; readonly mutations: readonly WorkerOfflineMutation[] }>;
  readonly pendingWrites: Set<PendingPortWrite>;
  readonly listeners: Set<WorkerManagedFirestoreListener>;
  readonly releaseLensWatch: () => void;
}

const portStates = new WeakMap<ClientPort, PortFirestoreState>();

registerPortTerminationReset((port) => {
  const existing = portStates.get(port);
  existing?.releaseLensWatch();
  portStates.delete(port);
});

function stateForPort(port: ClientPort): PortFirestoreState {
  let state = portStates.get(port);
  if (state === undefined) {
    const cachesByLens = new Map<string, LensWarmCache>();
    const releaseLensWatch = subscribeLens(() => {
      for (const cache of cachesByLens.values()) {
        for (const p of cache.baseDocs.keys()) {
          unmarkWorkerPathCached(port, p);
        }
      }
      cachesByLens.clear();
    });
    state = {
      networkEnabled: true,
      nextStageId: 1,
      cachesByLens,
      staged: [],
      pendingWrites: new Set(),
      listeners: new Set(),
      releaseLensWatch,
    };
    portStates.set(port, state);
  }
  return state;
}

function lensCacheFor(state: PortFirestoreState): LensWarmCache {
  const lens = getLens();
  let key = 'app-session';
  if (lens !== undefined) {
    key = JSON.stringify(lens);
  }
  let cache = state.cachesByLens.get(key);
  if (cache === undefined) {
    cache = { baseDocs: new Map(), warmExistingPaths: new Set() };
    state.cachesByLens.set(key, cache);
  }
  return cache;
}

export function isWorkerFirestoreOffline(port: ClientPort): boolean {
  return !stateForPort(port).networkEnabled;
}

export function recordWorkerOnlineDoc(
  port: ClientPort,
  path: string,
  exists: boolean,
  data: SerializedDocData | undefined,
): void {
  const cache = lensCacheFor(stateForPort(port));
  markWorkerPathCached(port, path);
  if (exists && data !== undefined) {
    cache.baseDocs.set(path, data);
    cache.warmExistingPaths.add(path);
  } else {
    cache.baseDocs.set(path, null);
    cache.warmExistingPaths.delete(path);
  }
}

export function markWorkerCommittedWrite(
  port: ClientPort,
  mutations: readonly WorkerOfflineMutation[],
): void {
  const cache = lensCacheFor(stateForPort(port));
  for (const m of mutations) {
    if (m.kind === 'delete') {
      cache.baseDocs.set(m.path, null);
      cache.warmExistingPaths.delete(m.path);
      unmarkWorkerPathCached(port, m.path);
    } else {
      const projected = projectWorkerOfflineDoc(m.path, cache.baseDocs.get(m.path), [{ mutations: [m] }]);
      if (projected.result.exists && projected.result.data !== undefined) {
        cache.baseDocs.set(m.path, projected.result.data);
      }
      cache.warmExistingPaths.add(m.path);
      markWorkerPathCached(port, m.path);
    }
  }
}

export function readWorkerCachedDocProjection(
  port: ClientPort,
  path: string,
): { readonly known: boolean; readonly result: RawDocResult } {
  const state = stateForPort(port);
  const cache = lensCacheFor(state);
  return projectWorkerOfflineDoc(path, cache.baseDocs.get(path), state.staged);
}

export function isWorkerTargetWarm(port: ClientPort, target: TargetDescriptor): boolean {
  const cache = lensCacheFor(stateForPort(port));
  if (target.__ref === 'doc') return cache.warmExistingPaths.has(target.path);
  for (const path of cache.warmExistingPaths) {
    if (targetMatchesPath(target, path)) return true;
  }
  return false;
}

export function readWorkerOfflineDoc(port: ClientPort, path: string): RawDocResult | undefined {
  const state = stateForPort(port);
  if (state.networkEnabled) return undefined;
  const cache = lensCacheFor(state);
  const projected = projectWorkerOfflineDoc(path, cache.baseDocs.get(path), state.staged);
  if (!projected.known) return undefined;
  return projected.result;
}

export function buildWorkerOfflineWire(
  port: ClientPort,
  target: TargetDescriptor,
): RawDocResult | RawQueryResult {
  const state = stateForPort(port);
  const cache = lensCacheFor(state);
  if (target.__ref === 'doc') {
    return projectWorkerOfflineDoc(target.path, cache.baseDocs.get(target.path), state.staged).result;
  }
  return projectWorkerOfflineQuery(target, cache.baseDocs, state.staged);
}

export function registerWorkerManagedListener(
  port: ClientPort,
  listener: WorkerManagedFirestoreListener,
): () => void {
  const state = stateForPort(port);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function enqueueWorkerOfflineWrite<T>(
  port: ClientPort,
  mutations: readonly WorkerOfflineMutation[],
  sendOnline: () => Promise<T>,
): Promise<T> {
  const state = stateForPort(port);
  for (const m of mutations) {
    if (m.kind === 'delete') {
      unmarkWorkerPathCached(port, m.path);
    } else {
      markWorkerPathCached(port, m.path);
    }
  }
  const stageId = state.nextStageId;
  state.nextStageId += 1;
  state.staged.push({ id: stageId, mutations });

  const touchedPaths = mutations.map((m) => m.path);
  queueMicrotask(() => {
    if (state.networkEnabled) return;
    for (const listener of [...state.listeners]) {
      if (touchedPaths.some((p) => targetMatchesPath(listener.target, p))) {
        listener.deliverOfflineWire(buildWorkerOfflineWire(port, listener.target));
      }
    }
  });

  let resolveOut: ((value: T) => void) | undefined;
  let rejectOut: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveOut = res;
    rejectOut = rej;
  });
  const clearStaged = (): void => {
    const idx = state.staged.findIndex((s) => s.id === stageId);
    if (idx >= 0) state.staged.splice(idx, 1);
  };
  let flushed = false;
  const entry: PendingPortWrite = {
    promise,
    flush: async () => {
      if (flushed) return;
      flushed = true;
      try {
        const result = await sendOnline();
        clearStaged();
        markWorkerCommittedWrite(port, mutations);
        state.pendingWrites.delete(entry);
        resolveOut?.(result);
      } catch (error) {
        clearStaged();
        state.pendingWrites.delete(entry);
        rejectOut?.(error);
      }
    },
  };
  state.pendingWrites.add(entry);
  return promise;
}

const AUTO_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateWorkerAutoId(): string {
  let out = '';
  for (let i = 0; i < 20; i += 1) {
    const idx = Math.floor(Math.random() * AUTO_ID_CHARS.length);
    out += AUTO_ID_CHARS.charAt(idx);
  }
  return out;
}

export async function disableNetwork(db: ClientDb): Promise<void> {
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  const state = stateForPort(db.port);
  if (!state.networkEnabled) return;
  state.networkEnabled = false;
  for (const listener of [...state.listeners]) {
    listener.suspendFromHost();
    if (!listener.hasDelivered()) {
      queueMicrotask(() => {
        if (!state.networkEnabled && state.listeners.has(listener) && !listener.hasDelivered()) {
          listener.deliverOfflineWire(buildWorkerOfflineWire(db.port, listener.target));
        }
      });
    }
  }
}

export async function enableNetwork(db: ClientDb): Promise<void> {
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  const state = stateForPort(db.port);
  const wasOffline = !state.networkEnabled;
  state.networkEnabled = true;
  for (const pending of [...state.pendingWrites]) {
    await pending.flush();
  }
  if (wasOffline) {
    for (const listener of [...state.listeners]) {
      listener.resumeOnHost();
    }
  }
}

export async function waitForPendingWrites(db: ClientDb): Promise<void> {
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  const state = stateForPort(db.port);
  const snapshot = [...state.pendingWrites].map((w) => w.promise);
  await Promise.allSettled(snapshot);
}
