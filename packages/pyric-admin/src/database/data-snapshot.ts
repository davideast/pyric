/**
 * Backend-agnostic `DataSnapshot` implementation shared by the local and remote
 * `pyric-admin/database` arms.
 */

import {
  asSdkArray,
  executeQuery,
  valueAtChildPath,
  type Priority,
} from 'pyric/database/internal';
import { joinPath, pathSegments } from './tree-store.js';
import type { DataSnapshot, JsonValue, Reference } from './types.js';

export interface SnapshotChildEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly exportValue?: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractExportPriority(exported: unknown): Priority {
  if (!isPlainRecord(exported) || !Object.hasOwn(exported, '.priority')) {
    return null;
  }
  const raw = exported['.priority'];
  const isValidPriority = typeof raw === 'string' || typeof raw === 'number';
  if (!isValidPriority) return null;
  return raw;
}

function exportedChildAt(exported: unknown, key: string): unknown {
  if (!isPlainRecord(exported)) {
    if (Array.isArray(exported)) return valueAtChildPath(exported, [key]);
    return undefined;
  }
  if (Object.hasOwn(exported, '.value')) {
    const inner = exported['.value'];
    if (isPlainRecord(inner) && Object.hasOwn(inner, key)) {
      return inner[key];
    }
    return undefined;
  }
  if (!Object.hasOwn(exported, key)) return undefined;
  return exported[key];
}

function toStoredChildRecord(stored: JsonValue): Record<string, JsonValue> | null {
  if (stored === null || typeof stored !== 'object') return null;
  if (Array.isArray(stored)) {
    const record: Record<string, JsonValue> = {};
    for (let i = 0; i < stored.length; i++) {
      const item = stored[i];
      if (item !== undefined && item !== null) {
        record[String(i)] = item;
      }
    }
    return record;
  }
  return stored as Record<string, JsonValue>;
}

/**
 * Children ordered by `(priority, nameCompare)` matching Firebase
 * `ChildrenNode` iteration when no explicit top-level query order applies.
 */
function defaultOrderedChildren(
  stored: JsonValue,
  exported: unknown,
): SnapshotChildEntry[] {
  const record = toStoredChildRecord(stored);
  if (record === null) return [];
  const rows = executeQuery(
    record,
    { orderBy: null, bounds: [], limit: null },
    (childKey) => extractExportPriority(exportedChildAt(exported, childKey)),
  );
  return rows.map((row) => ({
    key: row.key,
    value: row.value as JsonValue,
    exportValue: exportedChildAt(exported, row.key),
  }));
}

/**
 * Renders `val()` (`exportFormat === false`) or `exportVal()` / `toJSON()`
 * (`exportFormat === true`) with keys assigned in `(priority, nameCompare)`
 * order per `RT-7`, matching `pyric/database` `renderNode` and `firebase-admin`.
 */
function renderSnapshotNode(
  stored: JsonValue,
  exported: unknown,
  exportFormat: boolean,
): JsonValue {
  if (stored === null) return null;
  const priority = exportFormat ? extractExportPriority(exported) : null;
  const record = toStoredChildRecord(stored);
  if (record === null) {
    if (priority === null) return stored;
    return { '.value': stored, '.priority': priority };
  }
  const rendered: Record<string, JsonValue> = {};
  for (const entry of defaultOrderedChildren(record, exported)) {
    rendered[entry.key] = renderSnapshotNode(entry.value, entry.exportValue, exportFormat);
  }
  if (!exportFormat) {
    return asSdkArray(rendered) ?? rendered;
  }
  if (priority !== null) {
    rendered['.priority'] = priority;
  }
  return rendered;
}

function resolveForEachChildExport(
  entry: SnapshotChildEntry,
  lookupChildExport: (segs: readonly string[]) => unknown,
): unknown {
  if (entry.exportValue !== undefined) {
    return entry.exportValue;
  }
  return lookupChildExport([entry.key]);
}

export function buildSandboxSnap(
  refAt: (path: string) => Reference,
  path: string,
  stored: JsonValue,
  exported?: unknown,
  orderedEntries?: readonly SnapshotChildEntry[],
): DataSnapshot {
  const segs = pathSegments(path);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const exists = stored !== null;
  const children: readonly SnapshotChildEntry[] =
    orderedEntries ?? defaultOrderedChildren(stored, exported);
  const exportedChild = (childSegs: readonly string[]): unknown => {
    if (childSegs.length === 0) return exported;
    if (childSegs.length === 1 && orderedEntries !== undefined) {
      const matched = orderedEntries.find((candidate) => candidate.key === childSegs[0]);
      if (matched !== undefined && matched.exportValue !== undefined) {
        return matched.exportValue;
      }
    }
    let cursor: unknown = exported;
    for (const seg of childSegs) {
      if (cursor === undefined || cursor === null) return undefined;
      cursor = exportedChildAt(cursor, seg);
    }
    return cursor;
  };

  const snap = {
    key,
    get ref(): Reference {
      return refAt(path);
    },
    exists(): boolean {
      return exists;
    },
    val(): unknown {
      return renderSnapshotNode(stored, exported, false);
    },
    child(p: string): DataSnapshot {
      const childSegs = pathSegments(p);
      const childVal = valueAtChildPath(stored, childSegs) as JsonValue;
      return buildSandboxSnap(
        refAt,
        joinPath([...segs, ...childSegs]),
        childVal,
        exportedChild(childSegs),
      );
    },
    hasChild(p: string): boolean {
      return snap.child(p).exists();
    },
    hasChildren(): boolean {
      return children.length > 0;
    },
    numChildren(): number {
      return children.length;
    },
    forEach(cb: (child: DataSnapshot) => boolean | void): boolean {
      for (const entry of children) {
        const childExport = resolveForEachChildExport(entry, exportedChild);
        const childSnap = buildSandboxSnap(
          refAt,
          joinPath([...segs, entry.key]),
          entry.value,
          childExport,
        );
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
    toJSON(): unknown {
      return snap.exportVal();
    },
    getPriority(): string | number | null {
      if (!exists) return null;
      return extractExportPriority(exported);
    },
    exportVal(): unknown {
      if (!exists) return null;
      return renderSnapshotNode(stored, exported, true);
    },
  };
  return snap as unknown as DataSnapshot;
}
