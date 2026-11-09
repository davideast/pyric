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

export function buildSandboxSnap(
  refAt: (path: string) => Reference,
  path: string,
  stored: JsonValue,
  exported?: unknown,
): DataSnapshot {
  const segs = pathSegments(path);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const exists = stored !== null;
  const children = valueChildren(stored);
  const exportedChild = (childSegs: readonly string[]): unknown =>
    exported === undefined ? undefined : valueAtChildPath(exported, childSegs);

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
      for (const { key: childKey, value } of children) {
        const childSnap = buildSandboxSnap(
          refAt,
          joinPath([...segs, childKey]),
          value as JsonValue,
          exportedChild([childKey]),
        );
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
    toJSON(): unknown {
      return snap.exportVal();
    },
    getPriority(): string | number | null {
      if (
        !exists ||
        exported === undefined ||
        exported === null ||
        typeof exported !== 'object' ||
        Array.isArray(exported) ||
        !Object.hasOwn(exported, '.priority')
      ) {
        return null;
      }
      const priority = (exported as Record<string, unknown>)['.priority'];
      return typeof priority === 'string' || typeof priority === 'number' ? priority : null;
    },
    exportVal(): unknown {
      if (!exists) return null;
      return structuredClone(exported === undefined ? stored : exported);
    },
  };
  return snap as unknown as DataSnapshot;
}
