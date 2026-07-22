/** RTDB snapshot wire shape and Firebase-compatible client hydration. */
import type { RtdbDataSnapshot, RtdbRefHandle } from './handles.js';
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
      return makeRtdbSnapshot(
        rtdbChild(refHandle, path),
        childValue(path),
        undefined,
        entry?.priority ?? null,
        undefined,
        entry?.exportValue ?? exportValueAt(exportValue, path),
      );
    },
    hasChild: (path) => childValue(path) !== null && childValue(path) !== undefined,
    hasChildren: () => size > 0,
    exportVal: () => exportValue ?? null,
    toJSON: () => exportValue ?? null,
    forEach: (callback) => {
      const orderedEntries: RtdbWireEntry[] = entries ?? (
        !value || typeof value !== 'object' || Array.isArray(value)
          ? []
          : Object.entries(value as Record<string, unknown>)
              .map(([key, child]) => ({ key, value: child }))
      );
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

export function hydrateRtdbSnapshot(
  refHandle: RtdbRefHandle,
  wire: unknown,
): RtdbDataSnapshot {
  const payload = wire as RtdbWireSnapshot;
  return makeRtdbSnapshot(
    refHandle,
    payload.value ?? null,
    payload.exists,
    payload.priority ?? null,
    payload.entries,
    payload.exportValue ?? payload.value ?? null,
  );
}
