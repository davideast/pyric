/**
 * Local in-process RTDB listener registration (`on`, `off`, `once`) backed by
 * `RtdbBackend#adminOnValue` / `RtdbBackend#adminOnChild` and
 * `AdminListenerTable`.
 */

import type { Database as ModularDatabase } from 'pyric/database';
import {
  assertGettablePath,
  exportDatabaseVal,
  isDefaultQuerySpec,
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
  resolveOnceCallbacks,
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

function hydrateLocalChildSnap(
  target: LocalListenTarget,
  parentSegs: readonly string[],
  raw: LocalChildRawEvent,
): DataSnapshot {
  const childSegs = [...parentSegs, raw.key];
  const childPath = joinPath(childSegs);
  const exported = raw.priorities !== undefined
    ? exportFromRecordedPriorities(childPath, raw.val, raw.priorities)
    : exportedLocalValueAt(target.adminDb, childSegs, raw.val);
  return buildSandboxSnap(target.refAt, childPath, raw.val, exported);
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

function onceLocalChildListener(
  target: LocalListenTarget,
  segs: readonly string[],
  spec: QuerySpec,
  eventType: ChildEventType,
  successCb: unknown,
  failureCb: ((error: Error) => unknown) | undefined,
  boundContext: unknown,
): Promise<DataSnapshot> {
  const isQuery = !isDefaultQuerySpec(spec);
  return new Promise<DataSnapshot>((resolve, reject) => {
    let detach: (() => void) | undefined;
    let isSettled = false;
    try {
      assertGettablePath(target.canonical);
      const attachedUnsub = target.backend.adminOnChild(
        eventType,
        target.canonical,
        (raw) => {
          if (isSettled) return;
          isSettled = true;
          if (detach !== undefined) {
            const fn = detach;
            detach = undefined;
            fn();
          }
          const snap = hydrateLocalChildSnap(target, segs, raw);
          const prevKey = eventType === 'child_removed' ? null : raw.previousChildName;
          if (typeof successCb === 'function') {
            try {
              (successCb as SnapshotCallback).call(boundContext, snap, prevKey);
            } catch {
              // Callback error does not reject the once() promise once snapshot arrived.
            }
          }
          resolve(snap);
        },
        isQuery ? spec : undefined,
      );
      if (isSettled) {
        attachedUnsub();
      } else {
        detach = attachedUnsub;
      }
    } catch (err) {
      if (failureCb !== undefined) {
        try {
          failureCb.call(boundContext, err as Error);
        } catch {
          // Ignore secondary callback throw before rejecting with the read error.
        }
      }
      reject(err);
    }
  });
}

export async function onceLocalListener(
  target: LocalListenTarget,
  spec: QuerySpec,
  eventType: EventType,
  successCb?: unknown,
  failureCallbackOrContext?: unknown,
  context?: unknown,
): Promise<DataSnapshot> {
  assertValidEventType('once', eventType);
  const segs = pathSegments(target.canonical);
  const { failureCb, boundContext } = resolveOnceCallbacks(failureCallbackOrContext, context);
  if (isChildEventType(eventType)) {
    return onceLocalChildListener(target, segs, spec, eventType, successCb, failureCb, boundContext);
  }
  let snap: DataSnapshot;
  try {
    assertGettablePath(target.canonical);
    if (!isDefaultQuerySpec(spec)) {
      let capturedRows: QueryRow[] = [];
      const detach = target.backend.adminOnValue(
        target.canonical,
        (raw) => {
          capturedRows = raw.rows ?? [];
        },
        spec,
      );
      detach();
      snap = buildLocalQuerySnapshot(target.refAt, target.adminDb, target.canonical, segs, capturedRows);
    } else {
      const val = target.backend.adminGet(target.canonical);
      snap = buildSandboxSnap(
        target.refAt,
        target.canonical,
        val,
        exportedLocalValueAt(target.adminDb, segs, val),
      );
    }
  } catch (err) {
    if (failureCb !== undefined) {
      try {
        failureCb.call(boundContext, err as Error);
      } catch {
        // Ignore secondary callback throw before rejecting with the read error.
      }
    }
    throw err;
  }
  if (typeof successCb === 'function') {
    try {
      (successCb as (s: DataSnapshot) => unknown).call(boundContext, snap);
    } catch {
      // Callback error does not reject the once() promise once snapshot arrived.
    }
  }
  return snap;
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
  const segs = pathSegments(target.canonical);
  const { failureCb, boundContext } = resolveOnceCallbacks(cancelCallbackOrContext, context);
  const normalizedContext = boundContext ?? undefined;
  const isQuery = !isDefaultQuerySpec(spec);

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

  try {
    let attachedUnsub: () => void;
    if (isChildEventType(eventType)) {
      attachedUnsub = target.backend.adminOnChild(
        eventType,
        target.canonical,
        (raw) => {
          if (!entry.active) return;
          const snap = hydrateLocalChildSnap(target, segs, raw);
          const prevKey = eventType === 'child_removed' ? null : raw.previousChildName;
          callback.call(normalizedContext, snap, prevKey);
        },
        isQuery ? spec : undefined,
      );
    } else {
      attachedUnsub = target.backend.adminOnValue(
        target.canonical,
        (raw) => {
          if (!entry.active) return;
          const snap = hydrateLocalValueSnap(target, segs, isQuery, raw);
          callback.call(normalizedContext, snap, null);
        },
        isQuery ? spec : undefined,
      );
    }
    if (entry.active) {
      unsub = attachedUnsub;
    } else {
      // Callback synchronously invoked off() during initial fire.
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
  const normalizedContext = context ?? undefined;
  target.listeners.detachMatching(
    target.canonical,
    spec,
    eventType,
    callback,
    normalizedContext,
  );
}
