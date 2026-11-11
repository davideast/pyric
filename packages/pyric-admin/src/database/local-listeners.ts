/**
 * Local in-process RTDB listener registration (`on`, `off`, `once`) backed by
 * the shared `RtdbBackend#adminOnValue` plane and `AdminListenerTable`.
 */

import type { Database as ModularDatabase } from 'pyric/database';
import {
  assertGettablePath,
  exportDatabaseVal,
  isDefaultQuerySpec,
  valueAtChildPath,
  type QueryRow,
  type QuerySpec,
} from 'pyric/database/internal';
import { buildSandboxSnap, type SnapshotChildEntry } from './data-snapshot.js';
import type { AdminListenerTable } from './listener-table.js';
import { pathSegments } from './tree-store.js';
import {
  notImplemented,
  resolveOnceCallbacks,
  type DataSnapshot,
  type EventType,
  type JsonValue,
  type Reference,
  type SnapshotCallback,
} from './types.js';

export interface LocalListenBackend {
  adminGet(path: string): JsonValue;
  adminOnValue(
    path: string,
    cb: (snap: { val: JsonValue; exists: boolean; key: string | null; rows?: QueryRow[] }) => void,
    query?: QuerySpec,
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

export async function onceLocalListener(
  target: LocalListenTarget,
  spec: QuerySpec,
  eventType: EventType,
  successCb?: unknown,
  failureCallbackOrContext?: unknown,
  context?: unknown,
): Promise<DataSnapshot> {
  if (eventType !== 'value') {
    throw notImplemented(`once('${eventType}')`);
  }
  const segs = pathSegments(target.canonical);
  const { failureCb, boundContext } = resolveOnceCallbacks(failureCallbackOrContext, context);
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
  if (eventType !== 'value') {
    throw notImplemented(`on('${eventType}')`);
  }
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
    const attachedUnsub = target.backend.adminOnValue(
      target.canonical,
      (raw) => {
        if (!entry.active) return;
        const snap = hydrateLocalValueSnap(target, segs, isQuery, raw);
        callback.call(normalizedContext, snap, null);
      },
      isQuery ? spec : undefined,
    );
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
  const normalizedContext = context ?? undefined;
  target.listeners.detachMatching(
    target.canonical,
    spec,
    eventType,
    callback,
    normalizedContext,
  );
}
