/**
 * Local in-process RTDB listener registration (`on`, `off`, `once`) backed by
 * `RtdbBackend#adminOnValue` / `RtdbBackend#adminOnChild` and
 * `AdminListenerTable`.
 */

import {
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue as modularOnValue,
  QUERY_SYMBOL,
  ref as modularRef,
  type Database as ModularDatabase,
  type DatabaseReference as ModularReference,
  type DataSnapshot as ModularDataSnapshot,
  type Query as ModularQuery,
} from 'pyric/database';
import {
  exportDatabaseVal,
  isDefaultQuerySpec,
  isInfoPath,
  normalizeNode,
  valueAtChildPath,
  type Priority,
  type QueryRow,
  type QuerySpec,
} from 'pyric/database/internal';
import {
  assertValidEventType,
  isChildEventType,
  type ChildEventType,
} from './child-diff.js';
import { buildSandboxSnap, type SnapshotChildEntry } from './data-snapshot.js';
import type { AdminListenerTable } from './listener-table.js';
import { joinPath, pathSegments } from './tree-store.js';
import {
  resolveListenerArgs,
  validateCallbackArg,
  validateContextArg,
  type DataSnapshot,
  type EventType,
  type JsonValue,
  type Reference,
  type SnapshotCallback,
} from './types.js';

export interface LocalChildRawEvent {
  key: string;
  val: JsonValue;
  previousChildName: string | null;
  priorities?: Record<string, Priority>;
}

export interface LocalListenBackend {
  adminGet(path: string): JsonValue;
  adminOnValue(
    path: string,
    cb: (snap: { val: JsonValue; exists: boolean; key: string | null; rows?: QueryRow[] }) => void,
    query?: QuerySpec,
  ): () => void;
  adminOnChild(
    event: ChildEventType,
    path: string,
    cb: (snap: LocalChildRawEvent) => void,
    spec?: QuerySpec,
  ): () => void;
}

export interface LocalListenTarget {
  readonly adminDb: ModularDatabase;
  readonly backend: LocalListenBackend;
  readonly listeners: AdminListenerTable;
  readonly canonical: string;
  readonly refAt: (path: string) => Reference;
}

export function exportedLocalValueAt(
  adminDb: ModularDatabase,
  segs: readonly string[],
  val: JsonValue,
): unknown {
  if (val === null) return null;
  const rootExported = exportDatabaseVal(adminDb);
  return segs.length === 0 ? rootExported : valueAtChildPath(rootExported, segs);
}

function exportFromRecordedPriorities(
  path: string,
  val: JsonValue,
  priorities: Readonly<Record<string, Priority>>,
): JsonValue {
  if (val === null) return null;
  const priority = priorities[path] ?? null;
  const isLeaf = typeof val !== 'object' || Array.isArray(val);
  if (isLeaf) {
    return priority === null ? val : { '.value': val, '.priority': priority };
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, childVal] of Object.entries(val as Record<string, JsonValue>)) {
    const childPath = path === '/' ? `/${key}` : `${path}/${key}`;
    out[key] = exportFromRecordedPriorities(childPath, childVal, priorities);
  }
  if (priority !== null) {
    out['.priority'] = priority;
  }
  return out;
}

function resolveChildExportValue(
  target: LocalListenTarget,
  childPath: string,
  childSegs: readonly string[],
  raw: LocalChildRawEvent,
): unknown {
  if (raw.priorities !== undefined) {
    return exportFromRecordedPriorities(childPath, raw.val, raw.priorities);
  }
  return exportedLocalValueAt(target.adminDb, childSegs, raw.val);
}

function hydrateLocalChildSnap(
  target: LocalListenTarget,
  parentSegs: readonly string[],
  raw: LocalChildRawEvent,
): DataSnapshot {
  const childSegs = [...parentSegs, raw.key];
  const childPath = joinPath(childSegs);
  const exported = resolveChildExportValue(target, childPath, childSegs, raw);
  return buildSandboxSnap(target.refAt, childPath, raw.val, exported);
}

function toModularTarget(
  adminDb: ModularDatabase,
  canonical: string,
  spec: QuerySpec,
): ModularReference | ModularQuery {
  const baseRef = modularRef(adminDb, canonical);
  if (isDefaultQuerySpec(spec)) return baseRef;
  return {
    ref: baseRef,
    _spec: spec,
    [QUERY_SYMBOL]: true,
    isEqual(other: ModularQuery | null): boolean {
      if (other === null) return false;
      return other.ref === baseRef && other._spec === spec;
    },
    toJSON(): string {
      return baseRef.toString();
    },
    toString(): string {
      return baseRef.toString();
    },
  } as unknown as ModularQuery;
}

function hydrateModularSnap(
  refAt: (path: string) => Reference,
  canonical: string,
  modSnap: ModularDataSnapshot,
  preserveOrder: boolean,
): DataSnapshot {
  const stored = normalizeNode(modSnap.val() ?? null);
  const exported = modSnap.exportVal();
  if (!preserveOrder) {
    return buildSandboxSnap(refAt, canonical, stored, exported);
  }
  const orderedEntries: SnapshotChildEntry[] = [];
  modSnap.forEach((child) => {
    if (child.key !== null) {
      orderedEntries.push({
        key: child.key,
        value: normalizeNode(child.val() ?? null),
        exportValue: child.exportVal(),
      });
    }
  });
  return buildSandboxSnap(refAt, canonical, stored, exported, orderedEntries);
}

function subscribeLocalInfo(
  target: LocalListenTarget,
  segs: readonly string[],
  spec: QuerySpec,
  eventType: EventType,
  onDelivery: (snap: DataSnapshot, prevKey: string | null) => void,
  onError: (err: Error) => void,
): () => void {
  const modTarget = toModularTarget(target.adminDb, target.canonical, spec);
  const isQuery = !isDefaultQuerySpec(spec);
  if (!isChildEventType(eventType)) {
    return modularOnValue(
      modTarget,
      (modSnap) => {
        onDelivery(hydrateModularSnap(target.refAt, target.canonical, modSnap, isQuery), null);
      },
      onError,
    );
  }
  const handleChild = (modSnap: ModularDataSnapshot, prevKey: string | null): void => {
    const childKey = modSnap.key ?? '';
    const childPath = joinPath([...segs, childKey]);
    const snap = hydrateModularSnap(target.refAt, childPath, modSnap, false);
    const normalizedPrev = eventType === 'child_removed' ? null : prevKey;
    onDelivery(snap, normalizedPrev);
  };
  if (eventType === 'child_added') return onChildAdded(modTarget, handleChild, onError);
  if (eventType === 'child_changed') return onChildChanged(modTarget, handleChild, onError);
  if (eventType === 'child_removed') return onChildRemoved(modTarget, handleChild, onError);
  return onChildMoved(modTarget, handleChild, onError);
}

export function buildLocalQuerySnapshot(
  refAt: (path: string) => Reference,
  adminDb: ModularDatabase,
  canonical: string,
  segs: readonly string[],
  rows: readonly QueryRow[],
): DataSnapshot {
  if (rows.length === 0) {
    return buildSandboxSnap(refAt, canonical, null, null, []);
  }
  const stored: Record<string, JsonValue> = {};
  for (const row of rows) {
    stored[row.key] = row.value;
  }
  const fullExport = exportedLocalValueAt(adminDb, segs, stored);
  const exportedWindow: Record<string, unknown> = {};
  const isExportRecord =
    fullExport !== null &&
    typeof fullExport === 'object' &&
    !Array.isArray(fullExport);
  if (isExportRecord && Object.hasOwn(fullExport, '.priority')) {
    exportedWindow['.priority'] = (fullExport as Record<string, unknown>)['.priority'];
  }
  const entries: SnapshotChildEntry[] = [];
  for (const row of rows) {
    const rawChildExport = isExportRecord ? valueAtChildPath(fullExport, [row.key]) : null;
    const childExport = rawChildExport ?? row.value;
    exportedWindow[row.key] = childExport;
    entries.push({
      key: row.key,
      value: row.value,
      exportValue: childExport,
    });
  }
  return buildSandboxSnap(refAt, canonical, stored, exportedWindow, entries);
}

function hydrateLocalValueSnap(
  target: LocalListenTarget,
  segs: readonly string[],
  isQuery: boolean,
  raw: { val: JsonValue; rows?: QueryRow[] },
): DataSnapshot {
  if (isQuery) {
    return buildLocalQuerySnapshot(
      target.refAt,
      target.adminDb,
      target.canonical,
      segs,
      raw.rows ?? [],
    );
  }
  return buildSandboxSnap(
    target.refAt,
    target.canonical,
    raw.val,
    exportedLocalValueAt(target.adminDb, segs, raw.val),
  );
}

function attachRawLocalSubscription(
  target: LocalListenTarget,
  segs: readonly string[],
  spec: QuerySpec,
  eventType: EventType,
  onDelivery: (snap: DataSnapshot, prevKey: string | null) => void,
  onError: (err: Error) => void,
): () => void {
  if (isInfoPath(target.canonical)) {
    return subscribeLocalInfo(target, segs, spec, eventType, onDelivery, onError);
  }
  const isQuery = !isDefaultQuerySpec(spec);
  let queryArg: QuerySpec | undefined;
  if (isQuery) {
    queryArg = spec;
  }
  if (isChildEventType(eventType)) {
    return target.backend.adminOnChild(
      eventType,
      target.canonical,
      (raw) => {
        const snap = hydrateLocalChildSnap(target, segs, raw);
        const prevKey = eventType === 'child_removed' ? null : raw.previousChildName;
        onDelivery(snap, prevKey);
      },
      queryArg,
    );
  }
  return target.backend.adminOnValue(
    target.canonical,
    (raw) => {
      onDelivery(hydrateLocalValueSnap(target, segs, isQuery, raw), null);
    },
    queryArg,
  );
}

function deliverListenerSnapshot(
  eventType: EventType,
  callback: unknown,
  context: unknown,
  snap: DataSnapshot,
  prevKey: string | null,
): void {
  if (typeof callback !== 'function') return;
  try {
    if (eventType === 'value') {
      (callback as (this: unknown, s: DataSnapshot) => unknown).call(context, snap);
    } else {
      (callback as SnapshotCallback).call(context, snap, prevKey);
    }
  } catch {
    // Isolate user listener callback throws per Firebase RTDB observer contract.
  }
}

export function onceLocalListener(
  target: LocalListenTarget,
  spec: QuerySpec,
  eventType: EventType,
  successCb?: unknown,
  failureCallbackOrContext?: unknown,
  context?: unknown,
): Promise<DataSnapshot> {
  assertValidEventType('once', eventType);
  validateCallbackArg('Query.once', 'callback', successCb, true);
  const { failureCb, boundContext } = resolveListenerArgs(
    'Query.once',
    failureCallbackOrContext,
    context,
  );
  const segs = pathSegments(target.canonical);

  return new Promise<DataSnapshot>((resolve, reject) => {
    let detach: (() => void) | undefined;
    let isSettled = false;
    const failOnce = (err: Error): void => {
      if (isSettled) return;
      isSettled = true;
      if (detach !== undefined) {
        const fn = detach;
        detach = undefined;
        fn();
      }
      if (failureCb !== undefined) {
        try {
          failureCb.call(boundContext, err);
        } catch {
          // Ignore secondary callback throw before rejecting with the read error.
        }
      }
      reject(err);
    };

    try {
      const attachedUnsub = attachRawLocalSubscription(
        target,
        segs,
        spec,
        eventType,
        (snap, prevKey) => {
          if (isSettled) return;
          isSettled = true;
          if (detach !== undefined) {
            const fn = detach;
            detach = undefined;
            fn();
          }
          deliverListenerSnapshot(eventType, successCb, boundContext, snap, prevKey);
          resolve(snap);
        },
        failOnce,
      );
      if (isSettled) {
        attachedUnsub();
      } else {
        detach = attachedUnsub;
      }
    } catch (err) {
      failOnce(err as Error);
    }
  });
}

export function attachLocalListener(
  target: LocalListenTarget,
  spec: QuerySpec,
  eventType: EventType,
  callback: SnapshotCallback,
  cancelCallbackOrContext?: ((error: Error) => unknown) | object | null,
  context?: object | null,
): SnapshotCallback {
  assertValidEventType('on', eventType);
  validateCallbackArg('Query.on', 'callback', callback, false);
  const { failureCb, boundContext } = resolveListenerArgs(
    'Query.on',
    cancelCallbackOrContext,
    context,
  );
  const normalizedContext = boundContext ?? undefined;
  const segs = pathSegments(target.canonical);

  const entry = target.listeners.register(
    target.canonical,
    spec,
    eventType,
    callback,
    normalizedContext,
  );
  let unsub: (() => void) | undefined;
  entry.detach = () => {
    if (unsub !== undefined) {
      const fn = unsub;
      unsub = undefined;
      fn();
    }
  };

  let erroredSynchronously = false;
  try {
    const attachedUnsub = attachRawLocalSubscription(
      target,
      segs,
      spec,
      eventType,
      (snap, prevKey) => {
        if (!entry.active) return;
        deliverListenerSnapshot(eventType, callback, normalizedContext, snap, prevKey);
      },
      (err) => {
        erroredSynchronously = true;
        target.listeners.detachExact(entry);
        if (failureCb !== undefined) {
          failureCb.call(normalizedContext, err);
        } else {
          throw err;
        }
      },
    );
    const shouldRetain = entry.active && !erroredSynchronously;
    if (shouldRetain) {
      unsub = attachedUnsub;
    } else {
      attachedUnsub();
    }
  } catch (err) {
    target.listeners.detachExact(entry);
    if (failureCb !== undefined) {
      failureCb.call(normalizedContext, err as Error);
    } else {
      throw err;
    }
  }

  return callback;
}

export function detachLocalListener(
  target: LocalListenTarget,
  spec: QuerySpec,
  eventType?: EventType,
  callback?: SnapshotCallback,
  context?: object | null,
): void {
  if (eventType !== undefined) {
    assertValidEventType('off', eventType);
  }
  validateCallbackArg('Query.off', 'callback', callback, true);
  validateContextArg('Query.off', 'context', context);
  const normalizedCallback = callback ?? undefined;
  const normalizedContext = context ?? undefined;
  target.listeners.detachMatching(
    target.canonical,
    spec,
    eventType,
    normalizedCallback,
    normalizedContext,
  );
}
