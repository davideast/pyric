/** Per-(port, instance) RTDB offline outbound queue and listener isolation. */
import { resolveSentinels, type Priority } from 'pyric/database/internal';
import type { RtdbQuerySpec } from '../protocol.js';
import { sandboxNow } from './clock.js';
import type { RtdbDataSnapshot, RtdbRefHandle } from './handles.js';
import { markWorkerPathsWarm } from './rtdb-client-cache.js';
import {
  applyOverlaySetToScope,
  buildWireFromOverlay,
  canServeWorkerOfflineGet,
  dropWorkerOfflineStateForPort,
  normalizeWorkerSentinels,
  pathSegmentsOf,
  rebuildWorkerOverlay,
  recordServerWireOnScope,
  scopeForWorker,
  treeRead,
  workerPathsOverlap,
  type OverlayJson,
  type WorkerInstanceScopeRef,
  type WorkerOfflineListener,
  type WorkerOfflineScope,
  type WorkerQueuedAction,
  type WorkerWriteOverlay,
} from './rtdb-offline-overlay.js';
import { normalizeRtdbPath, withRtdbTransactionUpdate } from './rtdb-references.js';
import { hydrateRtdbSnapshot, makeRtdbSnapshot, type RtdbWireSnapshot } from './rtdb-snapshots.js';
import { validateRtdbTransactionValue } from './rtdb-value-validation.js';

export { dropWorkerOfflineStateForPort };

export function recordWorkerOnlineGetWire(
  ref: RtdbRefHandle,
  query: RtdbQuerySpec | undefined,
  wire: unknown,
): void {
  recordServerWireOnScope(scopeForWorker(ref), ref.path, wire, query);
}

function notifyWorkerOverlayListeners(scope: WorkerOfflineScope, changedPaths: readonly string[]): void {
  for (const listener of [...scope.listeners]) {
    if (!changedPaths.some((p) => workerPathsOverlap(p, listener.path))) {
      continue;
    }
    listener.onWireFromOverlay(buildWireFromOverlay(scope, listener.path, listener.query));
  }
}

export function isWorkerInstanceOffline(handle: WorkerInstanceScopeRef): boolean {
  return scopeForWorker(handle).offline;
}

export function setWorkerInstanceOffline(handle: WorkerInstanceScopeRef, offline: boolean): void {
  const scope = scopeForWorker(handle);
  if (offline) {
    if (scope.offline) {
      return;
    }
    scope.frozenTree = structuredClone(scope.serverTree);
    scope.frozenPriorities.clear();
    for (const [k, v] of scope.serverPriorities) {
      scope.frozenPriorities.set(k, v);
    }
    scope.offline = true;
    rebuildWorkerOverlay(scope);
    return;
  }
  if (!scope.offline) {
    return;
  }
  scope.offline = false;
  scope.coveringWritePaths.clear();
  rebuildWorkerOverlay(scope);

  for (const listener of [...scope.listeners]) {
    if (listener.deferredWire === undefined) {
      continue;
    }
    const deferred = listener.deferredWire;
    listener.deferredWire = undefined;
    const coveredByPending = scope.pendingOverlays.some((ov) =>
      ov.paths.some((p) => workerPathsOverlap(p, listener.path)),
    );
    if (coveredByPending) {
      listener.onWireFromOverlay(buildWireFromOverlay(scope, listener.path, listener.query));
    } else {
      listener.onWireFromOverlay(deferred);
    }
  }

  const actions = scope.queuedActions.splice(0);
  if (actions.length === 0) {
    return;
  }
  const hasTransaction = actions.some((a) => a.kind === 'transaction');
  if (!hasTransaction) {
    for (const action of actions) {
      void action.execute();
    }
    return;
  }
  void (async () => {
    for (const action of actions) {
      await action.execute();
    }
  })();
}

export function attachWorkerOfflineSubscription(
  ref: RtdbRefHandle,
  query: RtdbQuerySpec | undefined,
  onlyOnce: boolean,
  onWireFromOverlay: (wire: RtdbWireSnapshot) => void,
): {
  readonly receiveServerWire: (wire: unknown) => void;
  readonly close: () => void;
} {
  const scope = scopeForWorker(ref);
  const canonical = normalizeRtdbPath(ref.path);
  const entry: WorkerOfflineListener = {
    path: canonical,
    query,
    onlyOnce,
    onWireFromOverlay,
    deferredWire: undefined,
  };
  let initialLocalQueued = false;
  if (scope.offline && canServeWorkerOfflineGet(scope, canonical)) {
    initialLocalQueued = true;
    queueMicrotask(() => {
      if (scope.listeners.has(entry) && scope.offline) {
        onWireFromOverlay(buildWireFromOverlay(scope, canonical, query));
      }
    });
  }
  scope.listeners.add(entry);
  return {
    receiveServerWire(wire: unknown): void {
      recordServerWireOnScope(scope, canonical, wire, query, !onlyOnce);
      if (scope.offline) {
        if (!initialLocalQueued) {
          entry.deferredWire = wire as RtdbWireSnapshot;
        } else {
          entry.deferredWire = wire as RtdbWireSnapshot;
        }
        return;
      }
      const coveredByPending = scope.pendingOverlays.some((ov) =>
        ov.paths.some((p) => workerPathsOverlap(p, canonical)),
      );
      if (coveredByPending) {
        onWireFromOverlay(buildWireFromOverlay(scope, canonical, query));
        return;
      }
      onWireFromOverlay(wire as RtdbWireSnapshot);
    },
    close(): void {
      scope.listeners.delete(entry);
    },
  };
}

export function maybeWorkerOfflineGet(
  ref: RtdbRefHandle,
  query: RtdbQuerySpec | undefined,
  fetchOnline: () => Promise<RtdbDataSnapshot>,
): Promise<RtdbDataSnapshot> | undefined {
  const scope = scopeForWorker(ref);
  if (!scope.offline) {
    return undefined;
  }
  if (canServeWorkerOfflineGet(scope, ref.path)) {
    markWorkerPathsWarm(ref, [ref.path]);
    const wire = buildWireFromOverlay(scope, ref.path, query);
    return Promise.resolve(hydrateRtdbSnapshot(ref, wire));
  }
  return new Promise<RtdbDataSnapshot>((resolve, reject) => {
    const queued: WorkerQueuedAction = {
      kind: 'get',
      execute: async () => {
        try {
          resolve(await fetchOnline());
        } catch (err) {
          reject(err);
        }
      },
    };
    scope.queuedActions.push(queued);
  });
}

function enqueueWorkerWriteOverlay(
  ref: RtdbRefHandle,
  overlay: WorkerWriteOverlay,
  coveringPaths: readonly string[],
  sendOnline: () => Promise<void>,
): Promise<void> {
  const scope = scopeForWorker(ref);
  for (const covered of coveringPaths) {
    scope.coveringWritePaths.add(normalizeRtdbPath(covered));
  }
  scope.pendingOverlays.push(overlay);
  overlay.apply(scope);
  notifyWorkerOverlayListeners(scope, overlay.paths);

  return new Promise<void>((resolve, reject) => {
    scope.queuedActions.push({
      kind: 'write',
      execute: async () => {
        try {
          await sendOnline();
          const idx = scope.pendingOverlays.indexOf(overlay);
          if (idx >= 0) {
            scope.pendingOverlays.splice(idx, 1);
          }
          rebuildWorkerOverlay(scope);
          resolve();
        } catch (err) {
          const idx = scope.pendingOverlays.indexOf(overlay);
          if (idx >= 0) {
            scope.pendingOverlays.splice(idx, 1);
          }
          rebuildWorkerOverlay(scope);
          notifyWorkerOverlayListeners(scope, overlay.paths);
          reject(err);
        }
      },
    });
  });
}

export function enqueueWorkerOfflineSet(
  ref: RtdbRefHandle,
  path: string,
  value: unknown,
  priority: Priority,
  hasPriority: boolean,
  sendOnline: () => Promise<void>,
): Promise<void> {
  const canonical = normalizeRtdbPath(path);
  const now = sandboxNow();
  const overlay: WorkerWriteOverlay = {
    paths: [canonical],
    apply: (sc) => applyOverlaySetToScope(sc, canonical, value, priority, hasPriority, now),
  };
  return enqueueWorkerWriteOverlay(ref, overlay, [canonical], sendOnline);
}

export function enqueueWorkerOfflineUpdate(
  ref: RtdbRefHandle,
  path: string,
  values: Record<string, unknown>,
  sendOnline: () => Promise<void>,
): Promise<void> {
  const baseSegs = pathSegmentsOf(path);
  const now = sandboxNow();
  const entryPaths: string[] = [];
  for (const key of Object.keys(values)) {
    const segs = [...baseSegs, ...pathSegmentsOf(key)];
    if (segs.at(-1) === '.priority') {
      entryPaths.push(`/${segs.slice(0, -1).join('/')}`);
    } else {
      entryPaths.push(`/${segs.join('/')}`);
    }
  }
  const overlay: WorkerWriteOverlay = {
    paths: entryPaths,
    apply: (sc) => {
      for (const [key, rawVal] of Object.entries(values)) {
        const segs = [...baseSegs, ...pathSegmentsOf(key)];
        if (segs.at(-1) === '.priority') {
          const nodePath = normalizeRtdbPath(`/${segs.slice(0, -1).join('/')}`);
          if (treeRead(sc.overlayTree, nodePath) !== null) {
            const resolved = resolveSentinels(normalizeWorkerSentinels(rawVal), now, null) as Priority;
            sc.overlayPriorities.set(nodePath, resolved);
          }
          continue;
        }
        const absPath = normalizeRtdbPath(`/${segs.join('/')}`);
        applyOverlaySetToScope(sc, absPath, rawVal, null, false, now);
      }
    },
  };
  return enqueueWorkerWriteOverlay(ref, overlay, entryPaths, sendOnline);
}

export function enqueueWorkerOfflineSetPriority(
  ref: RtdbRefHandle,
  path: string,
  priority: Priority,
  sendOnline: () => Promise<void>,
): Promise<void> {
  const canonical = normalizeRtdbPath(path);
  const now = sandboxNow();
  const overlay: WorkerWriteOverlay = {
    paths: [canonical],
    apply: (sc) => {
      if (treeRead(sc.overlayTree, canonical) !== null) {
        const resolved = resolveSentinels(normalizeWorkerSentinels(priority), now, null) as Priority;
        sc.overlayPriorities.set(canonical, resolved);
      }
    },
  };
  return enqueueWorkerWriteOverlay(ref, overlay, [], sendOnline);
}

export function enqueueWorkerOfflineDisconnect(
  ref: RtdbRefHandle,
  sendOnline: () => Promise<void>,
): Promise<void> {
  const scope = scopeForWorker(ref);
  return new Promise<void>((resolve, reject) => {
    scope.queuedActions.push({
      kind: 'disconnect',
      execute: async () => {
        try {
          await sendOnline();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
    });
  });
}

export function runWorkerOfflineTransaction<T, R>(
  ref: RtdbRefHandle,
  transactionUpdate: (current: T | null) => T | undefined,
  applyLocally: boolean,
  buildAbort: (snap: RtdbDataSnapshot) => R,
  commitOnline: (initialInput: OverlayJson, proposed0: T) => Promise<R>,
): Promise<R> {
  const scope = scopeForWorker(ref);
  const canonical = normalizeRtdbPath(ref.path);
  let initialInput: OverlayJson = null;
  if (canServeWorkerOfflineGet(scope, canonical)) {
    const raw = treeRead(scope.overlayTree, canonical);
    if (raw !== null) {
      initialInput = buildWireFromOverlay(scope, canonical, undefined).value as OverlayJson;
    }
  }
  let clonedInput: T | null = null;
  if (initialInput !== null) {
    clonedInput = structuredClone(initialInput) as T;
  }
  const proposed0 = withRtdbTransactionUpdate(() => transactionUpdate(clonedInput));
  if (proposed0 === undefined) {
    let snap: RtdbDataSnapshot;
    if (initialInput === null) {
      snap = makeRtdbSnapshot(ref, null, false, null, [], null);
    } else {
      snap = hydrateRtdbSnapshot(ref, buildWireFromOverlay(scope, canonical, undefined));
    }
    return Promise.resolve().then(() => buildAbort(snap));
  }
  validateRtdbTransactionValue(proposed0, ref.path);

  const now = sandboxNow();
  let overlay: WorkerWriteOverlay | undefined;
  if (applyLocally) {
    overlay = {
      paths: [canonical],
      apply: (sc) => applyOverlaySetToScope(sc, canonical, proposed0, null, false, now),
    };
    scope.coveringWritePaths.add(canonical);
    scope.pendingOverlays.push(overlay);
    overlay.apply(scope);
    notifyWorkerOverlayListeners(scope, [canonical]);
  }

  return new Promise<R>((resolve, reject) => {
    scope.queuedActions.push({
      kind: 'transaction',
      execute: async () => {
        try {
          const outcome = await commitOnline(initialInput, proposed0);
          if (overlay !== undefined) {
            const idx = scope.pendingOverlays.indexOf(overlay);
            if (idx >= 0) {
              scope.pendingOverlays.splice(idx, 1);
            }
            rebuildWorkerOverlay(scope);
          }
          resolve(outcome);
        } catch (err) {
          if (overlay !== undefined) {
            const idx = scope.pendingOverlays.indexOf(overlay);
            if (idx >= 0) {
              scope.pendingOverlays.splice(idx, 1);
            }
            rebuildWorkerOverlay(scope);
            notifyWorkerOverlayListeners(scope, [canonical]);
          }
          reject(err);
        }
      },
    });
  });
}
