/** RTDB snapshot wire shape and Firebase-compatible client hydration. */
import type { RtdbDataSnapshot, RtdbRefHandle } from './handles.js';
import { executeQuery, valueChildren } from 'pyric/database/internal';
import { rtdbChild } from './rtdb-references.js';

export interface RtdbWireEntry {
  key: string;
  value: unknown;
  priority?: string | number | null;
  exportValue?: unknown;
}

export interface RtdbWireSnapshot {
  value?: unknown;
  exists?: boolean;
  key?: string | null;
  priority?: string | number | null;
  exportValue?: unknown;
  entries?: RtdbWireEntry[];
  /** On a listener's first snapshot: the unspecified-index warning the page logs. */
  warning?: string;
}

export function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

function exportValueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split('/').filter(Boolean)) {
    if (segment === '.priority' || segment === '.value') return null;
    if (current === null || typeof current !== 'object') return null;
    const record = current as Record<string, unknown>;
    const container = '.value' in record && Object.keys(record).every(
      (key) => key === '.value' || key === '.priority',
    ) ? record['.value'] : current;
    if (container === null || typeof container !== 'object') return null;
    current = (container as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

function priorityFromExport(exported: unknown): string | number | null {
  if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) return null;
  const candidate = (exported as Record<string, unknown>)['.priority'];
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : null;
}

function derivedEntries(value: unknown, exportValue: unknown): RtdbWireEntry[] {
  const children = valueChildren(value);
  if (children.length === 0) return [];
  const rawChildren = Object.fromEntries(
    children.map((entry) => [entry.key, entry.value]),
  ) as Parameters<typeof executeQuery>[0];
  return executeQuery(
    rawChildren,
    { orderBy: null, bounds: [], limit: null },
    (key) => priorityFromExport(exportValueAt(exportValue, key)),
  ).map((row) => ({
    key: row.key,
    value: row.value,
    priority: row.priority,
    exportValue: exportValueAt(exportValue, row.key) ?? row.value,
  }));
}

export function makeRtdbSnapshot(
  refHandle: RtdbRefHandle,
  value: unknown,
  exists?: boolean,
  priority: string | number | null = null,
  entries?: RtdbWireEntry[],
  exportValue: unknown = value,
): RtdbDataSnapshot {
  const childValue = (path: string) => valueAt(value, path);
  const size = entries?.length ?? (
    value && typeof value === 'object'
      ? Object.keys(value as Record<string, unknown>).filter((key) => valueAt(value, key) !== null).length
      : 0
  );
  return {
    key: refHandle.key,
    size,
    priority,
    exists: () => exists ?? (value !== null && value !== undefined),
    val: () => value ?? null,
    child: (path) => {
      const direct = path.split('/').filter(Boolean);
      const entry = direct.length === 1
        ? entries?.find((candidate) => candidate.key === direct[0])
        : undefined;
      const nextExport = entry?.exportValue ?? exportValueAt(exportValue, path);
      return makeRtdbSnapshot(
        rtdbChild(refHandle, path),
        childValue(path),
        undefined,
        entry?.priority ?? priorityFromExport(nextExport),
        undefined,
        nextExport,
      );
    },
    hasChild: (path) => childValue(path) !== null && childValue(path) !== undefined,
    hasChildren: () => size > 0,
    exportVal: () => exportValue ?? null,
    toJSON: () => exportValue ?? null,
    forEach: (callback) => {
      // Without the host's ordered entries (a `child()` or iterated
      // snapshot), an array value still has children keyed by index (#1110),
      // ordered by RTDB priority then key from `exportValue`.
      const orderedEntries: RtdbWireEntry[] = entries ?? derivedEntries(value, exportValue);
      for (const entry of orderedEntries) {
        if (callback(makeRtdbSnapshot(
          rtdbChild(refHandle, entry.key),
          entry.value,
          undefined,
          entry.priority ?? null,
          undefined,
          entry.exportValue ?? entry.value,
        )) === true) return true;
      }
      return false;
    },
    ref: refHandle,
  };
}

/**
 * `value` with each `null` array element turned back into a hole. The hosted
 * transport carries JSON, which writes a hole in `val()`'s sparse array as
 * `null`; RTDB never stores a `null` child, so every such `null` was a hole
 * (RT-6, #1371). A structured-clone port keeps holes, and this leaves them.
 */
export function restoreArrayHoles(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const restored: unknown[] = [];
    restored.length = value.length;
    value.forEach((element, index) => {
      if (element !== null) restored[index] = restoreArrayHoles(element);
    });
    return restored;
  }
  const restored: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) restored[key] = restoreArrayHoles(child);
  return restored;
}

export function hydrateRtdbSnapshot(
  refHandle: RtdbRefHandle,
  wire: unknown,
): RtdbDataSnapshot {
  const payload = wire as RtdbWireSnapshot;
  const entries = payload.entries?.map((entry) => ({ ...entry, value: restoreArrayHoles(entry.value) }));
  return makeRtdbSnapshot(
    refHandle,
    restoreArrayHoles(payload.value ?? null),
    payload.exists,
    payload.priority ?? null,
    entries,
    payload.exportValue ?? payload.value ?? null,
  );
}
