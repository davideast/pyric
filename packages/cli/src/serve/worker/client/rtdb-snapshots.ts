/** RTDB snapshot wire shape and client hydration. */
import type { RtdbDataSnapshot, RtdbRefHandle } from "./handles.js";
import { rtdbChild } from "./rtdb-references.js";

export function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

export interface RtdbWireEntry {
  key: string;
  value: unknown;
  priority?: string | number | null;
}

export interface RtdbWireSnapshot {
  value?: unknown;
  exists?: boolean;
  key?: string | null;
  priority?: string | number | null;
  entries?: RtdbWireEntry[];
}

export function makeRtdbSnapshot(
  refHandle: RtdbRefHandle,
  value: unknown,
  exists?: boolean,
  priority: string | number | null = null,
  entries?: RtdbWireEntry[],
): RtdbDataSnapshot {
  const childValue = (path: string) => valueAt(value, path);
  const size = entries?.length ?? (
    value && typeof value === 'object'
      ? Object.keys(value as Record<string, unknown>).filter((key) => valueAt(value, key) !== null).length
      : 0
  );
  const snapshot: RtdbDataSnapshot = {
    key: refHandle.key,
    size,
    priority,
    exists: () => exists ?? (value !== null && value !== undefined),
    val: () => value ?? null,
    child: (path) => {
      const direct = path.split('/').filter(Boolean);
      const entry = direct.length === 1 ? entries?.find((candidate) => candidate.key === direct[0]) : undefined;
      return makeRtdbSnapshot(
        rtdbChild(refHandle, path),
        childValue(path),
        undefined,
        entry?.priority ?? null,
      );
    },
    hasChild: (path) => childValue(path) !== null && childValue(path) !== undefined,
    hasChildren: () => size > 0,
    exportVal: () => value ?? null,
    toJSON: () => value ?? null,
    forEach: (cb) => {
      const orderedEntries: RtdbWireEntry[] = entries ?? (
        !value || typeof value !== 'object' || Array.isArray(value)
          ? []
          : Object.entries(value as Record<string, unknown>).map(([key, childValue]) => ({ key, value: childValue }))
      );
      for (const entry of orderedEntries) {
        if (cb(makeRtdbSnapshot(
          rtdbChild(refHandle, entry.key),
          entry.value,
          undefined,
          entry.priority ?? null,
        )) === true) return true;
      }
      return false;
    },
    ref: refHandle,
  };
  return snapshot;
}

export function hydrateRtdbSnapshot(refHandle: RtdbRefHandle, wire: unknown): RtdbDataSnapshot {
  const payload = wire as RtdbWireSnapshot;
  return makeRtdbSnapshot(
    refHandle,
    payload.value ?? null,
    payload.exists,
    payload.priority ?? null,
    payload.entries,
  );
}
