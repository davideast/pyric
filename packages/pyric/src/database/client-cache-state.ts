import { sdkActivity } from '../sandbox/internal/sdk-activity.js';
import type { ClientTransactionHooks } from './sandbox/client-transaction.js';
import { joinPath, pathSegments } from './sandbox/data-tree.js';
import { isAdminFor, type Target } from './routing.js';

interface WarmListenerEntry {
  readonly path: string;
}

interface ActiveColdTransaction {
  readonly path: string;
  abortedBySet: boolean;
}

interface TargetClientCache {
  resetGeneration: number;
  readonly warmPaths: Set<string>;
  readonly warmListeners: Set<WarmListenerEntry>;
  readonly activeColdTransactions: Set<ActiveColdTransaction>;
}

const caches = new WeakMap<Target, TargetClientCache>();
let clientTransactionUpdateDepth = 0;
let suppressWarmListenerDepth = 0;

function canonicalClientPath(path: string): string {
  return joinPath(pathSegments(path));
}

function clientPathsOverlap(left: string, right: string): boolean {
  if (left === '/' || right === '/' || left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function cacheForTarget(target: Target): TargetClientCache {
  const currentGen = target.backend.connectionResetGeneration;
  const existing = caches.get(target);
  if (existing !== undefined) {
    if (existing.resetGeneration !== currentGen) {
      existing.warmPaths.clear();
      existing.resetGeneration = currentGen;
    }
    return existing;
  }
  const created: TargetClientCache = {
    resetGeneration: currentGen,
    warmPaths: new Set(),
    warmListeners: new Set(),
    activeColdTransactions: new Set(),
  };
  caches.set(target, created);
  return created;
}

function bypassesClientCache(target: Target): boolean {
  return isAdminFor(target) || sdkActivity.isSilenced();
}

export function updateTargetPaths(basePath: string, values: Record<string, unknown>): string[] {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return [canonicalClientPath(basePath)];
  }
  const baseSegments = pathSegments(basePath);
  return keys.map((key) => joinPath([...baseSegments, ...pathSegments(key)]));
}

export function markClientPathsWarm(target: Target, paths: readonly string[]): void {
  if (bypassesClientCache(target)) {
    return;
  }
  const cache = cacheForTarget(target);
  for (const path of paths) {
    cache.warmPaths.add(canonicalClientPath(path));
  }
}

export function abortColdTransactionsOnClientWrite(
  target: Target,
  paths: readonly string[],
): void {
  if (bypassesClientCache(target) || clientTransactionUpdateDepth > 0) {
    return;
  }
  const cache = cacheForTarget(target);
  if (cache.activeColdTransactions.size === 0) {
    return;
  }
  const canonicalPaths = paths.map(canonicalClientPath);
  for (const active of cache.activeColdTransactions) {
    if (canonicalPaths.some((path) => clientPathsOverlap(active.path, path))) {
      active.abortedBySet = true;
    }
  }
}

export function withoutWarmListenerRegistration<T>(fn: () => T): T {
  suppressWarmListenerDepth += 1;
  try {
    return fn();
  } finally {
    suppressWarmListenerDepth -= 1;
  }
}

export function scheduleClientWarmListener(target: Target, path: string): () => void {
  if (bypassesClientCache(target) || suppressWarmListenerDepth > 0) {
    return () => {};
  }
  const canonical = canonicalClientPath(path);
  let closed = false;
  let entry: WarmListenerEntry | undefined;
  queueMicrotask(() => {
    if (closed) {
      return;
    }
    entry = { path: canonical };
    cacheForTarget(target).warmListeners.add(entry);
  });
  return () => {
    if (closed) {
      return;
    }
    closed = true;
    if (entry !== undefined) {
      cacheForTarget(target).warmListeners.delete(entry);
      entry = undefined;
    }
  };
}

function isClientPathWarm(target: Target, canonicalPath: string): boolean {
  if (bypassesClientCache(target)) {
    return true;
  }
  const cache = cacheForTarget(target);
  for (const warmPath of cache.warmPaths) {
    if (clientPathsOverlap(warmPath, canonicalPath)) {
      return true;
    }
  }
  for (const listener of cache.warmListeners) {
    if (clientPathsOverlap(listener.path, canonicalPath)) {
      return true;
    }
  }
  return false;
}

export function createClientTransactionHooks(
  target: Target,
  path: string,
): { cold: boolean; hooks: ClientTransactionHooks } {
  const canonical = canonicalClientPath(path);
  const cold = !isClientPathWarm(target, canonical);
  const hooks: ClientTransactionHooks = {
    runUpdate<R>(fn: () => R): R {
      clientTransactionUpdateDepth += 1;
      try {
        return fn();
      } finally {
        clientTransactionUpdateDepth -= 1;
      }
    },
    onWarm(): void {
      markClientPathsWarm(target, [canonical]);
    },
    onSent() {
      const entry: ActiveColdTransaction = { path: canonical, abortedBySet: false };
      cacheForTarget(target).activeColdTransactions.add(entry);
      return {
        isAbortedBySet: () => entry.abortedBySet,
        release: () => {
          cacheForTarget(target).activeColdTransactions.delete(entry);
        },
      };
    },
  };
  return { cold, hooks };
}
