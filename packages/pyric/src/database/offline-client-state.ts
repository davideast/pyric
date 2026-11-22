import { markClientPathsWarm } from './client-cache-state.js';
import type { ChildEvent } from './info-listeners.js';
import { loadsAllData, type Priority, type QueryRow, type QuerySpec } from './internal/query-projection.js';
import {
  bypassesClientOffline,
  canonicalOfflinePath,
  canServeOfflineGet,
  captureChildPriorities,
  computeActiveChildState,
  computeOverlayChildRows,
  computeOverlayValueSnapshot,
  emitChildDiff,
  notifyLocalOverlayListeners,
  pathsOverlap,
  priorityRecordBelow,
  priorityStateForValue,
  rebuildOverlay,
  stateFor,
  type OfflineChildListenerEntry,
  type OfflineValueListenerEntry,
  type OfflineWriteOverlay,
  type QueuedAction,
} from './offline-overlay-tree.js';
import type { Target } from './routing.js';
import type { ClientTransactionHooks } from './sandbox/client-transaction.js';
import { cloneJson, joinPath, jsonValuesEqual, pathSegments, type JsonValue } from './sandbox/data-tree.js';
import { runWithExceptionGuard } from './sandbox/exception-guard.js';
import { validateTransactionCandidate } from './sandbox/normalize.js';
import type { ChildEventSnapshot, ValueListenerSnapshot } from './sandbox/listener-types.js';
import {
  coerceArrays,
  errorPrefix,
  normalizeWrite,
  TRANSACTION_ERROR_PREFIX,
  writePriority,
} from './sandbox/normalize.js';
import { validateNestedPriorities, validatePriority, type PriorityRecord } from './sandbox/priority-state.js';
import { resolveSentinels } from './sandbox/sentinels.js';
import {
  buildSandboxQuerySnap,
  buildSandboxSnapFromRaw,
  renderSnapshotVal,
} from './snapshots.js';
import type { DataSnapshot, DatabaseReference, Query } from './types.js';

export function isClientOffline(target: Target): boolean {
  if (bypassesClientOffline(target)) {
    return false;
  }
  return stateFor(target).offline;
}

export function setClientOffline(target: Target, offline: boolean): void {
  if (bypassesClientOffline(target)) {
    return;
  }
  const state = stateFor(target);
  if (offline) {
    if (state.offline) {
      return;
    }
    state.frozenTree.restore(target.backend.snapshotState());
    state.frozenPriorities.clear();
    for (const [k, v] of target.backend.snapshotPriorities()) {
      state.frozenPriorities.set(k, v);
    }
    state.offline = true;
    rebuildOverlay(target, state);
    for (const childListener of state.childListeners) {
      const preDisconnectRows = computeOverlayChildRows(target, state, childListener.path, childListener.spec);
      childListener.rows = preDisconnectRows;
      childListener.priorities = captureChildPriorities(target, state, childListener.path, preDisconnectRows);
      childListener.initialized = true;
    }
    return;
  }
  if (!state.offline) {
    return;
  }
  state.offline = false;
  state.coveringWritePaths.clear();
  rebuildOverlay(target, state);

  for (const listener of [...state.valueListeners]) {
    if (listener.deferredRaw === undefined) {
      continue;
    }
    const raw = listener.deferredRaw;
    listener.deferredRaw = undefined;
    const coveredByPending = state.pendingOverlays.some((ov) =>
      ov.paths.some((p) => pathsOverlap(p, listener.path)),
    );
    let candidate = raw;
    if (coveredByPending) {
      candidate = computeOverlayValueSnapshot(target, state, listener.path, listener.spec);
    }
    const prioState = priorityStateForValue(state, target, listener.path, candidate.val);
    if (
      !listener.hasDelivered
      || listener.lastVal === undefined
      || !jsonValuesEqual(listener.lastVal, candidate.val)
      || listener.lastPriorityState !== prioState
    ) {
      listener.hasDelivered = true;
      listener.lastVal = cloneJson(candidate.val);
      listener.lastPriorityState = prioState;
      runWithExceptionGuard(() => listener.deliver(candidate));
    }
  }

  for (const childListener of [...state.childListeners]) {
    if (!childListener.deferredFromServer) {
      continue;
    }
    childListener.deferredFromServer = false;
    const nextRows = computeOverlayChildRows(target, state, childListener.path, childListener.spec);
    const nextPriorities = captureChildPriorities(target, state, childListener.path, nextRows);
    if (childListener.initialized) {
      emitChildDiff(target, state, childListener, nextRows, nextPriorities);
    }
  }

  const actions = state.queuedActions.splice(0);
  const asyncQueue: QueuedAction[] = [];
  for (const action of actions) {
    if (action.kind === 'disconnect') {
      void action.execute();
    } else {
      asyncQueue.push(action);
    }
  }
  if (asyncQueue.length > 0) {
    void (async () => {
      for (const action of asyncQueue) {
        await action.execute();
      }
    })();
  }
}

export function registerOfflineValueListener(
  target: Target,
  path: string,
  spec: QuerySpec | undefined,
  onlyOnce: boolean,
  deliver: (raw: ValueListenerSnapshot) => void,
): {
  readonly forwardBackend: (raw: ValueListenerSnapshot) => void;
  readonly close: () => void;
} {
  if (bypassesClientOffline(target)) {
    return { forwardBackend: deliver, close: () => {} };
  }
  const state = stateFor(target);
  const canonical = canonicalOfflinePath(path);
  const entry: OfflineValueListenerEntry = {
    path: canonical,
    spec,
    onlyOnce,
    deliver,
    lastVal: undefined,
    lastPriorityState: undefined,
    hasDelivered: false,
    deliveredOptimisticWhileOffline: false,
    deferredRaw: undefined,
  };
  state.valueListeners.add(entry);
  return {
    forwardBackend(raw: ValueListenerSnapshot): void {
      const activeState = stateFor(target);
      if (activeState.offline) {
        if (!entry.hasDelivered && canServeOfflineGet(activeState, canonical)) {
          const localSnap = computeOverlayValueSnapshot(target, activeState, canonical, spec);
          entry.hasDelivered = true;
          entry.deliveredOptimisticWhileOffline = true;
          entry.lastVal = cloneJson(localSnap.val);
          entry.lastPriorityState = priorityStateForValue(activeState, target, canonical, localSnap.val);
          deliver(localSnap);
          return;
        }
        entry.deferredRaw = raw;
        return;
      }
      const coveredByPending = activeState.pendingOverlays.some((ov) =>
        ov.paths.some((p) => pathsOverlap(p, canonical)),
      );
      if (coveredByPending) {
        const overlaid = computeOverlayValueSnapshot(target, activeState, canonical, spec);
        const prioState = priorityStateForValue(activeState, target, canonical, overlaid.val);
        if (
          entry.hasDelivered
          && entry.lastVal !== undefined
          && jsonValuesEqual(entry.lastVal, overlaid.val)
          && entry.lastPriorityState === prioState
        ) {
          return;
        }
        entry.hasDelivered = true;
        entry.lastVal = cloneJson(overlaid.val);
        entry.lastPriorityState = prioState;
        deliver(overlaid);
        return;
      }
      const prioState = priorityStateForValue(activeState, target, canonical, raw.val);
      if (entry.deliveredOptimisticWhileOffline) {
        entry.deliveredOptimisticWhileOffline = false;
        if (
          entry.hasDelivered
          && entry.lastVal !== undefined
          && jsonValuesEqual(entry.lastVal, raw.val)
          && entry.lastPriorityState === prioState
        ) {
          return;
        }
      }
      entry.hasDelivered = true;
      entry.lastVal = cloneJson(raw.val);
      entry.lastPriorityState = prioState;
      deliver(raw);
    },
    close(): void {
      stateFor(target).valueListeners.delete(entry);
    },
  };
}

export function registerOfflineChildListener(
  target: Target,
  event: ChildEvent,
  path: string,
  spec: QuerySpec | undefined,
  onlyOnce: boolean,
  deliver: (raw: ChildEventSnapshot) => void,
): {
  readonly forwardBackend: (raw: ChildEventSnapshot) => void;
  readonly close: () => void;
} {
  if (bypassesClientOffline(target)) {
    return { forwardBackend: deliver, close: () => {} };
  }
  const state = stateFor(target);
  const canonical = canonicalOfflinePath(path);
  const initialState = computeActiveChildState(target, state, canonical, spec);
  const entry: OfflineChildListenerEntry = {
    event,
    path: canonical,
    spec,
    onlyOnce,
    deliver,
    rows: initialState.rows,
    priorities: initialState.priorities,
    initialized: true,
    deferredFromServer: false,
  };
  state.childListeners.add(entry);
  return {
    forwardBackend(raw: ChildEventSnapshot): void {
      const activeState = stateFor(target);
      if (activeState.offline) {
        entry.deferredFromServer = true;
        return;
      }
      if (activeState.pendingOverlays.some((ov) => ov.paths.some((p) => pathsOverlap(p, canonical)))) {
        return;
      }
      const nextState = computeActiveChildState(target, activeState, canonical, spec);
      entry.rows = nextState.rows;
      entry.priorities = nextState.priorities;
      deliver(raw);
    },
    close(): void {
      stateFor(target).childListeners.delete(entry);
    },
  };
}

export function offlineClientGet(
  target: Target,
  ref0: DatabaseReference,
  query: Query | undefined,
  runOnline: () => DataSnapshot,
): Promise<DataSnapshot> | undefined {
  if (!isClientOffline(target)) {
    return undefined;
  }
  const state = stateFor(target);
  if (canServeOfflineGet(state, ref0._path)) {
    markClientPathsWarm(target, [ref0._path]);
    if (query !== undefined) {
      const snap = computeOverlayValueSnapshot(target, state, query.ref._path, query._spec);
      let rows: QueryRow[] = [];
      if (snap.rows !== undefined) {
        rows = snap.rows;
      }
      return Promise.resolve(
        buildSandboxQuerySnap(
          target,
          query.ref,
          rows,
          loadsAllData(query._spec),
          snap.val,
          snap.priorities,
        ),
      );
    }
    const val = state.overlayTree.read(ref0._path);
    const priorities = priorityRecordBelow(state, target, ref0._path, val);
    return Promise.resolve(buildSandboxSnapFromRaw(target, ref0, val, priorities));
  }
  return new Promise<DataSnapshot>((resolve, reject) => {
    state.queuedActions.push({
      kind: 'other',
      execute: async () => {
        try {
          resolve(runOnline());
        } catch (err) {
          reject(err);
        }
      },
    });
  });
}

function enqueueWriteOverlay(
  target: Target,
  overlay: OfflineWriteOverlay,
  coveringPaths: readonly string[],
  commitOnline: () => Promise<void>,
): Promise<void> {
  const state = stateFor(target);
  for (const covered of coveringPaths) {
    state.coveringWritePaths.add(canonicalOfflinePath(covered));
  }
  state.pendingOverlays.push(overlay);
  overlay.apply(state.overlayTree, state.overlayPriorities);
  notifyLocalOverlayListeners(target, state, overlay.paths);

  return new Promise<void>((resolve, reject) => {
    state.queuedActions.push({
      kind: 'write',
      overlay,
      execute: async () => {
        try {
          await commitOnline();
          const idx = state.pendingOverlays.indexOf(overlay);
          if (idx >= 0) {
            state.pendingOverlays.splice(idx, 1);
          }
          rebuildOverlay(target, state);
          resolve();
        } catch (err) {
          const idx = state.pendingOverlays.indexOf(overlay);
          if (idx >= 0) {
            state.pendingOverlays.splice(idx, 1);
          }
          rebuildOverlay(target, state);
          notifyLocalOverlayListeners(target, state, overlay.paths);
          reject(err);
        }
      },
    });
  });
}

export function enqueueOfflineClientSet(
  target: Target,
  path: string,
  value: unknown,
  priority: Priority,
  hasPriority: boolean,
  commitOnline: () => Promise<void>,
): Promise<void> {
  const canonical = canonicalOfflinePath(path);
  const now = target.backend.persistenceBackendState().clock.now();
  const overlay: OfflineWriteOverlay = {
    paths: [canonical],
    apply: (tree, priorities) => {
      const currentVal = coerceArrays(tree.read(canonical));
      const resolvedInput = resolveSentinels(value, now, currentVal);
      let normPath = canonical;
      if (canonical === '/') {
        normPath = '';
      }
      const resolved = normalizeWrite(resolvedInput, normPath);
      let basePrio: Priority = null;
      if (hasPriority) {
        let priorPrio: Priority = null;
        if (priorities.has(canonical)) {
          const got = priorities.get(canonical);
          if (got !== undefined) {
            priorPrio = got;
          }
        }
        basePrio = resolveSentinels(priority, now, priorPrio) as Priority;
      }
      const written = writePriority(resolvedInput, basePrio);
      tree.write(canonical, resolved);
      if (resolved === null) {
        priorities.set(canonical, null);
      } else {
        priorities.set(canonical, written.priority);
      }
    },
  };
  return enqueueWriteOverlay(target, overlay, [canonical], commitOnline);
}

export function enqueueOfflineClientUpdate(
  target: Target,
  path: string,
  values: Record<string, unknown>,
  commitOnline: () => Promise<void>,
): Promise<void> {
  const baseSegs = pathSegments(path);
  const now = target.backend.persistenceBackendState().clock.now();
  const entryPaths: string[] = [];
  for (const key of Object.keys(values)) {
    const segs = [...baseSegs, ...pathSegments(key)];
    if (segs.at(-1) === '.priority') {
      entryPaths.push(joinPath(segs.slice(0, -1)));
    } else {
      entryPaths.push(joinPath(segs));
    }
  }
  const overlay: OfflineWriteOverlay = {
    paths: entryPaths,
    apply: (tree, priorities) => {
      for (const [key, rawVal] of Object.entries(values)) {
        const segs = [...baseSegs, ...pathSegments(key)];
        if (segs.at(-1) === '.priority') {
          const nodePath = joinPath(segs.slice(0, -1));
          const resolvedPrio = resolveSentinels(rawVal, now, null) as Priority;
          if (tree.read(nodePath) !== null) {
            priorities.set(nodePath, resolvedPrio);
          }
          continue;
        }
        const absPath = joinPath(segs);
        const currentVal = coerceArrays(tree.read(absPath));
        const resolvedInput = resolveSentinels(rawVal, now, currentVal);
        const resolved = normalizeWrite(resolvedInput, absPath, errorPrefix('update', 'values'));
        tree.write(absPath, resolved);
      }
    },
  };
  return enqueueWriteOverlay(target, overlay, entryPaths, commitOnline);
}

export function enqueueOfflineClientSetPriority(
  target: Target,
  path: string,
  priority: Priority,
  commitOnline: () => Promise<void>,
): Promise<void> {
  const canonical = canonicalOfflinePath(path);
  const now = target.backend.persistenceBackendState().clock.now();
  const overlay: OfflineWriteOverlay = {
    paths: [canonical],
    apply: (tree, priorities) => {
      if (tree.read(canonical) !== null) {
        priorities.set(canonical, resolveSentinels(priority, now, null) as Priority);
      }
    },
  };
  return enqueueWriteOverlay(target, overlay, [], commitOnline);
}

export function enqueueOfflineClientDisconnect(
  target: Target,
  registerOnline: () => Promise<void>,
): Promise<void> {
  const state = stateFor(target);
  return new Promise<void>((resolve, reject) => {
    state.queuedActions.push({
      kind: 'disconnect',
      execute: async () => {
        try {
          await registerOnline();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
    });
  });
}

export function runOfflineClientTransaction<T, R>(
  target: Target,
  ref0: DatabaseReference,
  transactionUpdate: (current: T | null) => T | undefined,
  applyLocally: boolean,
  hooks: ClientTransactionHooks,
  abortResult: (rawVal: JsonValue, priorities: PriorityRecord) => R,
  commitOnline: (wrappedUpdate: (current: JsonValue) => JsonValue | undefined) => Promise<R>,
): Promise<R> {
  const state = stateFor(target);
  const canonical = canonicalOfflinePath(ref0._path);
  let initialRaw: JsonValue = null;
  let initialInput: JsonValue = null;
  if (canServeOfflineGet(state, canonical)) {
    initialRaw = state.overlayTree.read(canonical);
    if (initialRaw !== null) {
      const prioRecord = priorityRecordBelow(state, target, canonical, initialRaw);
      initialInput = renderSnapshotVal(canonical, initialRaw, (p) => {
        const key = canonicalOfflinePath(p);
        if (!Object.hasOwn(prioRecord, key)) return null;
        const stored = prioRecord[key];
        return stored === undefined ? null : stored;
      });
    }
  }
  const proposed0 = hooks.runUpdate(() =>
    (transactionUpdate as (cur: JsonValue) => JsonValue | undefined)(initialInput),
  );
  if (proposed0 === undefined) {
    const priorities = priorityRecordBelow(state, target, canonical, initialRaw);
    return Promise.resolve().then(() => abortResult(initialRaw, priorities));
  }
  validateTransactionCandidate(proposed0, canonical);
  const now = target.backend.persistenceBackendState().clock.now();
  const resolvedInput = resolveSentinels(proposed0, now, initialInput);
  let normPath = canonical;
  if (canonical === '/') {
    normPath = '';
  }
  const normalized0 = normalizeWrite(resolvedInput, normPath, TRANSACTION_ERROR_PREFIX);
  const written0 = writePriority(resolvedInput, null);
  validatePriority(written0.priority);
  validateNestedPriorities(pathSegments(canonical), written0.nested);

  let overlay: OfflineWriteOverlay | undefined;
  if (applyLocally) {
    overlay = {
      paths: [canonical],
      apply: (tree, priorities) => {
        tree.write(canonical, normalized0);
        if (normalized0 === null) {
          priorities.set(canonical, null);
        } else {
          priorities.set(canonical, written0.priority);
        }
      },
    };
    state.coveringWritePaths.add(canonical);
    state.pendingOverlays.push(overlay);
    overlay.apply(state.overlayTree, state.overlayPriorities);
    notifyLocalOverlayListeners(target, state, [canonical]);
  }

  return new Promise<R>((resolve, reject) => {
    state.queuedActions.push({
      kind: 'other',
      execute: async () => {
        let firstServerPass = true;
        try {
          const outcome = await commitOnline((serverCurrent) => {
            if (firstServerPass) {
              firstServerPass = false;
              if (jsonValuesEqual(serverCurrent, initialInput)) {
                return proposed0;
              }
            }
            return (transactionUpdate as (cur: JsonValue) => JsonValue | undefined)(serverCurrent);
          });
          if (overlay !== undefined) {
            const idx = state.pendingOverlays.indexOf(overlay);
            if (idx >= 0) {
              state.pendingOverlays.splice(idx, 1);
            }
            rebuildOverlay(target, state);
          }
          resolve(outcome);
        } catch (err) {
          if (overlay !== undefined) {
            const idx = state.pendingOverlays.indexOf(overlay);
            if (idx >= 0) {
              state.pendingOverlays.splice(idx, 1);
            }
            rebuildOverlay(target, state);
            notifyLocalOverlayListeners(target, state, [canonical]);
          }
          reject(err);
        }
      },
    });
  });
}
