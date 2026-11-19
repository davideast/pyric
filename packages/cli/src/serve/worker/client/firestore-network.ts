/**
 * Per-ClientPort Firestore network toggle (`disableNetwork`, `enableNetwork`,
 * `waitForPendingWrites`), warmed-path cache (#1355), and offline write queue
 * + listener suspension/resumption (FW-17, FS-143) for SharedWorker & Node host.
 */
import type { SerializedDocData, TargetDescriptor } from '../protocol.js';
import type { ClientDb, ClientPort } from './handles.js';
import type { RawDocResult, RawQueryResult } from './snapshots.js';
import {
  projectWorkerOfflineDoc,
  projectWorkerOfflineQuery,
  targetMatchesPath,
  type WorkerOfflineMutation,
} from './firestore-offline-projection.js';

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

interface PortFirestoreState {
  networkEnabled: boolean;
  nextStageId: number;
  readonly baseDocs: Map<string, SerializedDocData | null>;
  readonly warmExistingPaths: Set<string>;
  readonly staged: Array<{ readonly id: number; readonly mutations: readonly WorkerOfflineMutation[] }>;
  readonly pendingWrites: Set<PendingPortWrite>;
  readonly listeners: Set<WorkerManagedFirestoreListener>;
}

const portStates = new WeakMap<ClientPort, PortFirestoreState>();

function stateForPort(port: ClientPort): PortFirestoreState {
  let state = portStates.get(port);
  if (state === undefined) {
    state = {
      networkEnabled: true,
      nextStageId: 1,
      baseDocs: new Map(),
      warmExistingPaths: new Set(),
      staged: [],
      pendingWrites: new Set(),
      listeners: new Set(),
    };
    portStates.set(port, state);
  }
  return state;
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
  const state = stateForPort(port);
  if (exists && data !== undefined) {
    state.baseDocs.set(path, data);
    state.warmExistingPaths.add(path);
  } else {
    state.baseDocs.set(path, null);
    state.warmExistingPaths.delete(path);
  }
}

export function markWorkerCommittedWrite(
  port: ClientPort,
  mutations: readonly WorkerOfflineMutation[],
): void {
  const state = stateForPort(port);
  for (const m of mutations) {
    if (m.kind === 'delete') {
      state.baseDocs.set(m.path, null);
      state.warmExistingPaths.delete(m.path);
    } else {
      const projected = projectWorkerOfflineDoc(m.path, state.baseDocs.get(m.path), [{ mutations: [m] }]);
      if (projected.result.exists && projected.result.data !== undefined) {
        state.baseDocs.set(m.path, projected.result.data);
      }
      state.warmExistingPaths.add(m.path);
    }
  }
}

export function isWorkerTargetWarm(port: ClientPort, target: TargetDescriptor): boolean {
  const state = stateForPort(port);
  if (target.__ref === 'doc') return state.warmExistingPaths.has(target.path);
  for (const path of state.warmExistingPaths) {
    if (targetMatchesPath(target, path)) return true;
  }
  return false;
}

export function readWorkerOfflineDoc(port: ClientPort, path: string): RawDocResult | undefined {
  const state = stateForPort(port);
  if (state.networkEnabled) return undefined;
  const projected = projectWorkerOfflineDoc(path, state.baseDocs.get(path), state.staged);
  if (!projected.known) return undefined;
  return projected.result;
}

export function buildWorkerOfflineWire(
  port: ClientPort,
  target: TargetDescriptor,
): RawDocResult | RawQueryResult {
  const state = stateForPort(port);
  if (target.__ref === 'doc') {
    return projectWorkerOfflineDoc(target.path, state.baseDocs.get(target.path), state.staged).result;
  }
  return projectWorkerOfflineQuery(target, state.baseDocs, state.staged);
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

export function disableNetwork(db: ClientDb): Promise<void> {
  const state = stateForPort(db.port);
  if (!state.networkEnabled) return Promise.resolve();
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
  return Promise.resolve();
}

export async function enableNetwork(db: ClientDb): Promise<void> {
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

export function waitForPendingWrites(db: ClientDb): Promise<void> {
  const state = stateForPort(db.port);
  const snapshot = [...state.pendingWrites].map((w) => w.promise);
  return Promise.allSettled(snapshot).then(() => undefined);
}
