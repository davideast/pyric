import { sdkActivity } from '../sandbox/internal/sdk-activity.js';
import type { ChildEvent } from './info-listeners.js';
import {
  evaluateQueryRead,
  executeQuery,
  indexedOrderValueChanged,
  type Priority,
  type QueryRow,
  type QuerySpec,
} from './internal/query-projection.js';
import type { Target } from './routing.js';
import {
  cloneJson,
  DataTree,
  joinPath,
  jsonValuesEqual,
  pathSegments,
  type JsonValue,
} from './sandbox/data-tree.js';
import type { ChildEventSnapshot, ValueListenerSnapshot } from './sandbox/listener-types.js';
import type { PriorityRecord } from './sandbox/priority-state.js';

export interface OfflineWriteOverlay {
  readonly paths: string[];
  readonly apply: (tree: DataTree, priorities: Map<string, Priority>) => void;
}

export interface QueuedAction {
  readonly kind: 'write' | 'disconnect' | 'other';
  readonly overlay?: OfflineWriteOverlay;
  readonly execute: () => Promise<void>;
}

export interface OfflineValueListenerEntry {
  readonly path: string;
  readonly spec: QuerySpec | undefined;
  readonly onlyOnce: boolean;
  readonly deliver: (raw: ValueListenerSnapshot) => void;
  lastVal: JsonValue | undefined;
  hasDelivered: boolean;
  deliveredOptimisticWhileOffline: boolean;
  deferredRaw: ValueListenerSnapshot | undefined;
}

export interface OfflineChildListenerEntry {
  readonly event: ChildEvent;
  readonly path: string;
  readonly spec: QuerySpec | undefined;
  readonly onlyOnce: boolean;
  readonly deliver: (raw: ChildEventSnapshot) => void;
  rows: QueryRow[];
  initialized: boolean;
  deferredFromServer: boolean;
}

export interface TargetOfflineState {
  resetGeneration: number;
  offline: boolean;
  readonly frozenTree: DataTree;
  readonly overlayTree: DataTree;
  readonly overlayPriorities: Map<string, Priority>;
  readonly coveringWritePaths: Set<string>;
  readonly pendingOverlays: OfflineWriteOverlay[];
  readonly queuedActions: QueuedAction[];
  readonly valueListeners: Set<OfflineValueListenerEntry>;
  readonly childListeners: Set<OfflineChildListenerEntry>;
}

const states = new WeakMap<Target, TargetOfflineState>();

export function canonicalOfflinePath(path: string): string {
  return joinPath(pathSegments(path));
}

export function pathsOverlap(left: string, right: string): boolean {
  if (left === '/' || right === '/' || left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function ancestorCoversPath(ancestor: string, targetPath: string): boolean {
  if (ancestor === '/' || ancestor === targetPath) {
    return true;
  }
  return targetPath.startsWith(`${ancestor}/`);
}

function keyOfPath(path: string): string | null {
  const segs = pathSegments(path);
  if (segs.length === 0) {
    return null;
  }
  const last = segs[segs.length - 1];
  if (last === undefined) {
    return null;
  }
  return last;
}

export function bypassesClientOffline(target: Target): boolean {
  return target.admin === true || sdkActivity.isSilenced();
}

export function stateFor(target: Target): TargetOfflineState {
  const gen = target.backend.connectionResetGeneration;
  const existing = states.get(target);
  if (existing !== undefined) {
    if (existing.resetGeneration !== gen) {
      existing.resetGeneration = gen;
      existing.offline = false;
      existing.coveringWritePaths.clear();
      existing.pendingOverlays.length = 0;
      existing.queuedActions.length = 0;
      existing.overlayPriorities.clear();
      for (const listener of existing.valueListeners) {
        listener.deferredRaw = undefined;
      }
      for (const listener of existing.childListeners) {
        listener.deferredFromServer = false;
      }
    }
    return existing;
  }
  const created: TargetOfflineState = {
    resetGeneration: gen,
    offline: false,
    frozenTree: new DataTree(),
    overlayTree: new DataTree(),
    overlayPriorities: new Map(),
    coveringWritePaths: new Set(),
    pendingOverlays: [],
    queuedActions: [],
    valueListeners: new Set(),
    childListeners: new Set(),
  };
  states.set(target, created);
  return created;
}

export function priorityAt(state: TargetOfflineState, target: Target, path: string): Priority {
  const canonical = canonicalOfflinePath(path);
  if (state.overlayPriorities.has(canonical)) {
    const stored = state.overlayPriorities.get(canonical);
    if (stored === undefined) {
      return null;
    }
    return stored;
  }
  return target.backend.getPriority(canonical);
}

export function priorityRecordBelow(
  state: TargetOfflineState,
  target: Target,
  basePath: string,
  val: JsonValue,
): PriorityRecord {
  const out: PriorityRecord = {};
  const walk = (nodePath: string, node: JsonValue): void => {
    if (node === null) {
      return;
    }
    const prio = priorityAt(state, target, nodePath);
    if (prio !== null) {
      out[canonicalOfflinePath(nodePath)] = prio;
    }
    if (typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, childVal] of Object.entries(node as Record<string, JsonValue>)) {
        walk(joinPath([...pathSegments(nodePath), k]), childVal);
      }
    }
  };
  walk(basePath, val);
  return out;
}

export function rebuildOverlay(target: Target, state: TargetOfflineState): void {
  if (state.offline) {
    state.overlayTree.restore(state.frozenTree.snapshot());
  } else {
    state.overlayTree.restore(target.backend.snapshotState());
  }
  state.overlayPriorities.clear();
  for (const overlay of state.pendingOverlays) {
    overlay.apply(state.overlayTree, state.overlayPriorities);
  }
}

export function computeOverlayValueSnapshot(
  target: Target,
  state: TargetOfflineState,
  path: string,
  spec: QuerySpec | undefined,
): ValueListenerSnapshot {
  const raw = state.overlayTree.read(path);
  const key = keyOfPath(path);
  if (spec !== undefined) {
    const result = evaluateQueryRead(raw, spec, (childKey) =>
      priorityAt(state, target, joinPath([...pathSegments(path), childKey])),
    );
    return { val: result.val, exists: result.val !== null, key, rows: result.rows };
  }
  return { val: raw, exists: raw !== null, key };
}

export function computeOverlayChildRows(
  target: Target,
  state: TargetOfflineState,
  path: string,
  spec: QuerySpec | undefined,
): QueryRow[] {
  const raw = state.overlayTree.read(path);
  let effectiveSpec: QuerySpec = { orderBy: null, bounds: [], limit: null };
  if (spec !== undefined) {
    effectiveSpec = spec;
  }
  return executeQuery(raw, effectiveSpec, (childKey) =>
    priorityAt(state, target, joinPath([...pathSegments(path), childKey])),
  );
}

export function emitChildDiff(
  target: Target,
  state: TargetOfflineState,
  entry: OfflineChildListenerEntry,
  nextRows: QueryRow[],
): void {
  const prevByKey = new Map(entry.rows.map((r) => [r.key, r]));
  const nextByKey = new Map(nextRows.map((r) => [r.key, r]));
  if (entry.event === 'child_removed') {
    for (const prev of entry.rows) {
      if (!nextByKey.has(prev.key)) {
        entry.deliver({ key: prev.key, val: prev.value, previousChildName: null });
      }
    }
  } else {
    for (let i = 0; i < nextRows.length; i += 1) {
      const cur = nextRows[i];
      if (cur === undefined) {
        continue;
      }
      let prevKey: string | null = null;
      if (i > 0) {
        const prevEntry = nextRows[i - 1];
        if (prevEntry !== undefined) {
          prevKey = prevEntry.key;
        }
      }
      const prior = prevByKey.get(cur.key);
      const childPath = joinPath([...pathSegments(entry.path), cur.key]);
      if (entry.event === 'child_added' && prior === undefined) {
        entry.deliver({
          key: cur.key,
          val: cur.value,
          previousChildName: prevKey,
          priorities: priorityRecordBelow(state, target, childPath, cur.value),
        });
      } else if (
        entry.event === 'child_changed'
        && prior !== undefined
        && (!jsonValuesEqual(prior.value, cur.value) || prior.priority !== cur.priority)
      ) {
        entry.deliver({
          key: cur.key,
          val: cur.value,
          previousChildName: prevKey,
          priorities: priorityRecordBelow(state, target, childPath, cur.value),
        });
      } else if (entry.event === 'child_moved' && prior !== undefined) {
        let orderBy = null;
        if (entry.spec !== undefined) {
          orderBy = entry.spec.orderBy;
        }
        if (indexedOrderValueChanged(orderBy, cur.key, prior.value, prior.priority, cur.value, cur.priority)) {
          entry.deliver({
            key: cur.key,
            val: cur.value,
            previousChildName: prevKey,
            priorities: priorityRecordBelow(state, target, childPath, cur.value),
          });
        }
      }
    }
  }
  entry.rows = nextRows;
}

export function notifyLocalOverlayListeners(
  target: Target,
  state: TargetOfflineState,
  changedPaths: readonly string[],
): void {
  for (const listener of [...state.valueListeners]) {
    if (!changedPaths.some((p) => pathsOverlap(p, listener.path))) {
      continue;
    }
    const snap = computeOverlayValueSnapshot(target, state, listener.path, listener.spec);
    if (listener.hasDelivered && listener.lastVal !== undefined && jsonValuesEqual(listener.lastVal, snap.val)) {
      continue;
    }
    listener.hasDelivered = true;
    listener.deliveredOptimisticWhileOffline = true;
    listener.lastVal = cloneJson(snap.val);
    listener.deliver(snap);
  }
  for (const childListener of [...state.childListeners]) {
    if (!changedPaths.some((p) => pathsOverlap(p, childListener.path))) {
      continue;
    }
    const nextRows = computeOverlayChildRows(target, state, childListener.path, childListener.spec);
    if (!childListener.initialized) {
      childListener.initialized = true;
      childListener.rows = nextRows;
      continue;
    }
    emitChildDiff(target, state, childListener, nextRows);
  }
}

export function canServeOfflineGet(state: TargetOfflineState, targetPath: string): boolean {
  const canonical = canonicalOfflinePath(targetPath);
  for (const listener of state.valueListeners) {
    if (!listener.onlyOnce && ancestorCoversPath(listener.path, canonical)) {
      return true;
    }
  }
  for (const childListener of state.childListeners) {
    if (!childListener.onlyOnce && ancestorCoversPath(childListener.path, canonical)) {
      return true;
    }
  }
  for (const writePath of state.coveringWritePaths) {
    if (ancestorCoversPath(writePath, canonical)) {
      return true;
    }
  }
  return false;
}
