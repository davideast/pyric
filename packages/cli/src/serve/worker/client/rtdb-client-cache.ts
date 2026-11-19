/** Per-(port, instance) RTDB client cache warmth and SENT_NEEDS_ABORT tracking. */
import type { ClientPort, ClientRtdbInstance } from './handles.js';
import { isRtdbTransactionUpdateActive, normalizeRtdbPath } from './rtdb-references.js';

export interface WorkerRefScope {
  readonly port: ClientPort;
  readonly instance?: ClientRtdbInstance;
}

interface WarmListenerEntry {
  readonly path: string;
}

interface ActiveColdTransaction {
  readonly path: string;
  abortedBySet: boolean;
}

interface WorkerInstanceCache {
  readonly warmPaths: Set<string>;
  readonly warmListeners: Set<WarmListenerEntry>;
  readonly activeColdTransactions: Set<ActiveColdTransaction>;
}

const caches = new WeakMap<ClientPort, Map<string, WorkerInstanceCache>>();

function workerPathsOverlap(left: string, right: string): boolean {
  if (left === '/' || right === '/' || left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function cacheForScope(scope: WorkerRefScope): WorkerInstanceCache {
  let byInstance = caches.get(scope.port);
  if (byInstance === undefined) {
    byInstance = new Map();
    caches.set(scope.port, byInstance);
  }
  const key = scope.instance?.name ?? '';
  let existing = byInstance.get(key);
  if (existing === undefined) {
    existing = {
      warmPaths: new Set(),
      warmListeners: new Set(),
      activeColdTransactions: new Set(),
    };
    byInstance.set(key, existing);
  }
  return existing;
}

export function dropWorkerClientCacheForPort(port: ClientPort): void {
  caches.delete(port);
}

export function markWorkerPathsWarm(scope: WorkerRefScope, paths: readonly string[]): void {
  const cache = cacheForScope(scope);
  for (const path of paths) {
    cache.warmPaths.add(normalizeRtdbPath(path));
  }
}

export function abortWorkerColdTransactionsOnWrite(
  scope: WorkerRefScope,
  paths: readonly string[],
): void {
  if (isRtdbTransactionUpdateActive()) {
    return;
  }
  const cache = cacheForScope(scope);
  if (cache.activeColdTransactions.size === 0) {
    return;
  }
  const normalized = paths.map((path) => normalizeRtdbPath(path));
  for (const active of cache.activeColdTransactions) {
    if (normalized.some((path) => workerPathsOverlap(active.path, path))) {
      active.abortedBySet = true;
    }
  }
}

export function registerWorkerWarmListener(scope: WorkerRefScope, path: string): () => void {
  const entry: WarmListenerEntry = { path: normalizeRtdbPath(path) };
  const cache = cacheForScope(scope);
  cache.warmListeners.add(entry);
  return () => {
    cache.warmListeners.delete(entry);
  };
}

export function isWorkerPathWarm(scope: WorkerRefScope, path: string): boolean {
  const canonical = normalizeRtdbPath(path);
  const cache = cacheForScope(scope);
  for (const warmPath of cache.warmPaths) {
    if (workerPathsOverlap(warmPath, canonical)) {
      return true;
    }
  }
  for (const listener of cache.warmListeners) {
    if (workerPathsOverlap(listener.path, canonical)) {
      return true;
    }
  }
  return false;
}

export function beginWorkerColdTransaction(
  scope: WorkerRefScope,
  path: string,
): {
  readonly isAbortedBySet: () => boolean;
  readonly release: () => void;
} {
  const entry: ActiveColdTransaction = { path: normalizeRtdbPath(path), abortedBySet: false };
  const cache = cacheForScope(scope);
  cache.activeColdTransactions.add(entry);
  return {
    isAbortedBySet: () => entry.abortedBySet,
    release: () => {
      cache.activeColdTransactions.delete(entry);
    },
  };
}
