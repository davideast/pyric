/**
 * Backend-agnostic `DataSnapshot` implementation shared by the local and remote
 * `pyric-admin/database` arms.
 */

import {
  coerceArrays,
  valueAtChildPath,
  valueChildren,
} from 'pyric/database/internal';
import { joinPath, pathSegments } from './tree-store.js';
import type { DataSnapshot, JsonValue, Reference } from './types.js';

export interface SnapshotChildEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly exportValue?: unknown;
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
  const children: readonly SnapshotChildEntry[] = orderedEntries ?? valueChildren(stored).map(
    (entry) => ({ key: entry.key, value: entry.value as JsonValue }),
  );
  const exportedChild = (childSegs: readonly string[]): unknown => {
    if (childSegs.length === 1 && orderedEntries !== undefined) {
      const matched = orderedEntries.find((candidate) => candidate.key === childSegs[0]);
      if (matched !== undefined && matched.exportValue !== undefined) {
        return matched.exportValue;
      }
    }
    if (exported === undefined) return undefined;
    return valueAtChildPath(exported, childSegs);
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
      return coerceArrays(structuredClone(stored));
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
        const childExport = entry.exportValue !== undefined
          ? entry.exportValue
          : exportedChild([entry.key]);
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
      const isExportRecord =
        exported !== undefined &&
        exported !== null &&
        typeof exported === 'object' &&
        !Array.isArray(exported);
      if (!exists || !isExportRecord || !Object.hasOwn(exported, '.priority')) {
        return null;
      }
      const priority = (exported as Record<string, unknown>)['.priority'];
      const isValidPriority = typeof priority === 'string' || typeof priority === 'number';
      return isValidPriority ? priority : null;
    },
    exportVal(): unknown {
      if (!exists) return null;
      const source = exported === undefined ? stored : exported;
      return structuredClone(source);
    },
  };
  return snap as unknown as DataSnapshot;
}
