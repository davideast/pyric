import { asSdkArray } from './sandbox/normalize.js';
import { isReservedSegment, setOwnProperty, type JsonValue } from './sandbox/data-tree.js';
import { executeQuery, isScalarLeafValue, type Priority, type QueryRow } from './internal/query-projection.js';
import type { PriorityRecord } from './sandbox/priority-state.js';
import type { SandboxLiveTarget, SandboxTarget } from './routing.js';
import { DataSnapshot, type DatabaseReference, type DataSnapshotImplementation } from './types.js';
import { child } from './references.js';

function hasReservedSegment(path: string): boolean {
  return path.split('/').some(isReservedSegment);
}

function canonicalSnapshotPath(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

function childPathOf(basePath: string, key: string): string {
  if (basePath === '/' || basePath === '') return `/${key}`;
  return `${basePath}/${key}`;
}

// --- Snapshot wrappers ---

export function buildSandboxSnap(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  val: JsonValue,
): DataSnapshot {
  return buildSandboxSnapFromRaw(target, refForSnap, val);
}

/** Where a snapshot reads priorities: a captured record or the live tree at build time. */
type PriorityLookup = (path: string) => Priority;

function priorityLookup(target: SandboxTarget | SandboxLiveTarget, record?: PriorityRecord): PriorityLookup {
  if (record === undefined) {
    return (path) => target.backend.getPriority(path);
  }
  return recordPriorityLookup(record);
}

function recordPriorityLookup(record: PriorityRecord): PriorityLookup {
  return (path) => {
    const canonical = canonicalSnapshotPath(path);
    if (!Object.hasOwn(record, canonical)) return null;
    const stored = record[canonical];
    return stored === undefined ? null : stored;
  };
}

function captureSubtreePriorities(
  val: JsonValue,
  basePath: string,
  readPriority: PriorityLookup,
): PriorityRecord {
  const captured: PriorityRecord = {};
  const walk = (node: JsonValue, nodePath: string, reservedAncestor: boolean): void => {
    if (node === null || reservedAncestor) return;
    const canonical = canonicalSnapshotPath(nodePath);
    const ownPriority = readPriority(canonical);
    if (ownPriority !== null) {
      setOwnProperty(captured, canonical, ownPriority);
    }
    if (typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, childVal] of Object.entries(node as Record<string, JsonValue>)) {
      if (isReservedSegment(key)) continue;
      walk(childVal, childPathOf(canonical, key), false);
    }
  };
  walk(val, basePath, hasReservedSegment(basePath));
  return captured;
}

/**
 * A snapshot of `val` at `refForSnap`. `priorities`, when given, holds the
 * priorities of a subtree the tree no longer has (or an offline overlay);
 * otherwise they are captured from the tree when the snapshot is built so
 * later priority mutations cannot alter an existing snapshot (#1418).
 */
export function buildSandboxSnapFromRaw(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  val: JsonValue,
  priorities?: PriorityRecord,
): DataSnapshot {
  const captured = captureSubtreePriorities(
    val,
    refForSnap._path,
    priorityLookup(target, priorities),
  );
  return snapshotWithPriorities(target, refForSnap, val, recordPriorityLookup(captured));
}

function walkSnapshotSegments(val: JsonValue, relativePath: string): JsonValue {
  const segs = relativePath.split('/').filter((segment) => segment.length > 0);
  let cur: JsonValue = val;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, s)) {
      return null;
    }
    const next = (cur as Record<string, JsonValue>)[s];
    cur = next === undefined ? null : next;
  }
  return cur;
}

function countSnapshotChildren(val: JsonValue): number {
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    return Object.keys(val as Record<string, JsonValue>).length;
  }
  return 0;
}

function snapshotWithPriorities(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  val: JsonValue,
  priorityOf: PriorityLookup,
): DataSnapshot {
  const exists = val !== null;
  // `val` is the stored (integer-keyed) shape. Structural ops
  // (`child`/`forEach`/`hasChildren`/`numChildren`) walk it directly;
  // `val()`, `exportVal()` and `toJSON()` render from `priorityOf`.
  const childCount = countSnapshotChildren(val);
  const refHasReserved = hasReservedSegment(refForSnap._path);
  let priority: Priority = null;
  if (exists && !refHasReserved) {
    priority = priorityOf(refForSnap._path);
  }
  const implementation: DataSnapshotImplementation = {
    key: refForSnap.key,
    ref: refForSnap,
    size: childCount,
    priority,
    exists(): boolean { return exists; },
    val(): JsonValue { return renderNode(priorityOf, refForSnap._path, refHasReserved, val, false); },
    child(p: string): DataSnapshot {
      const childRef = child(refForSnap, p);
      const cur = walkSnapshotSegments(val, p);
      return snapshotWithPriorities(target, childRef, cur, priorityOf);
    },
    hasChild(p: string): boolean {
      return this.child(p).exists();
    },
    hasChildren(): boolean {
      return childCount > 0;
    },
    exportVal(): JsonValue { return renderNode(priorityOf, refForSnap._path, refHasReserved, val, true); },
    toJSON(): JsonValue { return renderNode(priorityOf, refForSnap._path, refHasReserved, val, true); },
    forEach(cb): boolean {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
      for (const { key, value } of childrenInPriorityOrder(priorityOf, refForSnap._path, refHasReserved, val)) {
        const childRef = child(refForSnap, key);
        const childSnap = snapshotWithPriorities(target, childRef, value, priorityOf);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
  };
  return new DataSnapshot(implementation);
}

/**
 * Build a snapshot from a query result. Differs from
 * {@link buildSandboxSnapFromRaw} in that the children iterate in the
 * order the executor produced them (not insertion order).
 *
 * `val()` returns a `Record<string, JsonValue>` containing only the
 * windowed children, the stored scalar leaf when `unfiltered` is `true` and
 * `rows` is empty, or `null` when the window is empty, matching
 * `firebase/database`'s `DataSnapshot.val()` on a query snap.
 *
 * `numChildren()` is the window size; `forEach` walks the ordered rows.
 */
export function buildSandboxQuerySnap(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  rows: QueryRow[],
  unfiltered = true,
  leafValue: JsonValue = null,
  priorities?: PriorityRecord,
): DataSnapshot {
  if (rows.length === 0 && unfiltered && isScalarLeafValue(leafValue)) {
    return buildSandboxSnapFromRaw(target, refForSnap, leafValue, priorities);
  }
  let val: JsonValue;
  if (rows.length === 0) {
    val = null;
  } else {
    const obj: Record<string, JsonValue> = {};
    for (const { key, value } of rows) setOwnProperty(obj, key, value);
    val = obj;
  }
  const exists = rows.length > 0;
  const refHasReserved = hasReservedSegment(refForSnap._path);
  const captured = captureSubtreePriorities(
    val,
    refForSnap._path,
    priorityLookup(target, priorities),
  );
  const priorityOf = recordPriorityLookup(captured);
  let priority: Priority = null;
  if (exists && unfiltered && !refHasReserved) {
    priority = priorityOf(refForSnap._path);
  }
  const implementation: DataSnapshotImplementation = {
    key: refForSnap.key,
    ref: refForSnap,
    size: rows.length,
    priority,
    exists(): boolean { return exists; },
    // Like production, `val()` and `exportVal()` order the window's keys by
    // priority, then key; only `forEach` follows the query's order (RT-7).
    val(): JsonValue { return renderNode(priorityOf, refForSnap._path, refHasReserved, val, false); },
    child(p: string): DataSnapshot {
      const childRef = child(refForSnap, p);
      const cur = walkSnapshotSegments(val, p);
      return snapshotWithPriorities(target, childRef, cur, priorityOf);
    },
    hasChild(p: string): boolean {
      return this.child(p).exists();
    },
    hasChildren(): boolean { return rows.length > 0; },
    exportVal(): JsonValue {
      return renderNode(priorityOf, refForSnap._path, refHasReserved, val, true, unfiltered);
    },
    toJSON(): JsonValue {
      return renderNode(priorityOf, refForSnap._path, refHasReserved, val, true, unfiltered);
    },
    forEach(cb): boolean {
      for (const { key, value } of rows) {
        const childRef = child(refForSnap, key);
        const childSnap = snapshotWithPriorities(target, childRef, value, priorityOf);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
  };
  return new DataSnapshot(implementation);
}

/**
 * Render a stored RTDB value as `DataSnapshot.val()` exposes it: object keys
 * ordered by `(priority, nameCompare)` at every depth and dense integer-keyed
 * maps coerced to arrays with sparse holes (#1419).
 */
export function renderSnapshotVal(
  nodePath: string,
  value: JsonValue,
  readPriority: (path: string) => Priority,
): JsonValue {
  return renderNode(readPriority, nodePath, hasReservedSegment(nodePath), value, false);
}

/** The children of a stored object in priority, then key order, as `forEach` walks them. */
function childrenInPriorityOrder(
  priorityOf: PriorityLookup,
  basePath: string,
  hasReservedAncestor: boolean,
  value: Record<string, JsonValue>,
): QueryRow[] {
  return executeQuery(
    value,
    { orderBy: null, bounds: [], limit: null },
    (key) => {
      if (hasReservedAncestor || isReservedSegment(key)) return null;
      return priorityOf(childPathOf(basePath, key));
    },
  );
}

/**
 * A stored value as `val()` renders it (`exportFormat` false) or as
 * `exportVal()` and `toJSON()` do (`exportFormat` true). Mirrors upstream
 * `ChildrenNode.val(exportFormat)` and `LeafNode.val(exportFormat)`: keys
 * are assigned in priority, then key order (RT-7); only `val()` renders an
 * integer-keyed node as an array, with holes at missing indexes; only the
 * export carries `.priority` and `.value` (RT-6, #1371).
 */
function renderNode(
  priorityOf: PriorityLookup,
  nodePath: string,
  hasReservedAncestor: boolean,
  value: JsonValue,
  exportFormat: boolean,
  includeOwnPriority = true,
): JsonValue {
  if (value === null) return null;
  let priority: Priority = null;
  if (exportFormat && includeOwnPriority && !hasReservedAncestor) {
    priority = priorityOf(nodePath);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (priority === null) return value;
    return { '.value': value, '.priority': priority };
  }
  const rendered: Record<string, JsonValue> = {};
  for (const { key, value: childValue } of childrenInPriorityOrder(
    priorityOf,
    nodePath,
    hasReservedAncestor,
    value,
  )) {
    const childReserved = hasReservedAncestor || isReservedSegment(key);
    const renderedChild = renderNode(
      priorityOf,
      childPathOf(nodePath, key),
      childReserved,
      childValue,
      exportFormat,
    );
    setOwnProperty(rendered, key, renderedChild);
  }
  if (!exportFormat) {
    const array = asSdkArray(rendered);
    if (array !== null) return array;
    return rendered;
  }
  if (priority !== null) rendered['.priority'] = priority;
  return rendered;
}
