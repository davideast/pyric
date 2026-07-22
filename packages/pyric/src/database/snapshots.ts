import { coerceArrays } from './sandbox/normalize.js';
import { pathSegments, type JsonValue } from './sandbox/data-tree.js';
import { executeQuery, type QueryRow } from './sandbox/query.js';
import type { SandboxLiveTarget, SandboxTarget } from './routing.js';
import { DataSnapshot, type DatabaseReference, type DataSnapshotImplementation } from './types.js';
import { child } from './references.js';

// ─── Snapshot wrappers ───────────────────────────────────────────────

export function buildSandboxSnap(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  val: JsonValue,
): DataSnapshot {
  return buildSandboxSnapFromRaw(target, refForSnap, val);
}

export function buildSandboxSnapFromRaw(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  val: JsonValue,
): DataSnapshot {
  const exists = val !== null;
  // `val` is the STORED (integer-keyed) shape. Structural ops
  // (`child`/`forEach`/`hasChildren`/`numChildren`) walk it directly;
  // `val()`/`toJSON()` render the DB-B2 array coercion lazily so a list
  // written as an array reads back as an array.
  const coerced = coerceArrays(val);
  const childCount = (val !== null && typeof val === 'object' && !Array.isArray(val))
    ? Object.keys(val as Record<string, JsonValue>).length
    : 0;
  const priority = target.backend.getPriority(refForSnap._path);
  const implementation: DataSnapshotImplementation = {
    key: refForSnap.key,
    ref: refForSnap,
    size: childCount,
    priority,
    exists(): boolean { return exists; },
    val(): JsonValue { return coerced; },
    child(p: string): DataSnapshot {
      const segs = pathSegments(p);
      let cur: JsonValue = val;
      for (const s of segs) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
          cur = null;
          break;
        }
        cur = (cur as Record<string, JsonValue>)[s] ?? null;
      }
      const childRef = child(refForSnap, p);
      return buildSandboxSnapFromRaw(target, childRef, cur);
    },
    hasChild(p: string): boolean {
      return this.child(p).exists();
    },
    hasChildren(): boolean {
      return val !== null && typeof val === 'object' && !Array.isArray(val)
        && Object.keys(val as Record<string, JsonValue>).length > 0;
    },
    exportVal(): JsonValue { return exportValueAt(target, refForSnap, val).value; },
    toJSON(): JsonValue { return exportValueAt(target, refForSnap, val).value; },
    forEach(cb): boolean {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
      const rows = executeQuery(
        val,
        { orderBy: null, bounds: [], limit: null },
        (key) => target.backend.getPriority(child(refForSnap, key)._path),
      );
      for (const { key, value } of rows) {
        const childRef = child(refForSnap, key);
        const childSnap = buildSandboxSnapFromRaw(target, childRef, value);
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
 * windowed children (or `null` if the window is empty), matching
 * `firebase/database`'s `DataSnapshot.val()` on a query snap.
 *
 * `numChildren()` is the window size; `forEach` walks the ordered rows.
 */
export function buildSandboxQuerySnap(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  rows: QueryRow[],
): DataSnapshot {
  let val: JsonValue;
  if (rows.length === 0) {
    val = null;
  } else {
    const obj: Record<string, JsonValue> = {};
    for (const { key, value } of rows) obj[key] = value;
    val = obj;
  }
  const exists = rows.length > 0;
  const coerced = coerceArrays(val);
  const implementation: DataSnapshotImplementation = {
    key: refForSnap.key,
    ref: refForSnap,
    size: rows.length,
    priority: target.backend.getPriority(refForSnap._path),
    exists(): boolean { return exists; },
    val(): JsonValue { return coerced; },
    child(p: string): DataSnapshot {
      const segs = pathSegments(p);
      let cur: JsonValue = val;
      for (const s of segs) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
          cur = null;
          break;
        }
        cur = (cur as Record<string, JsonValue>)[s] ?? null;
      }
      const childRef = child(refForSnap, p);
      return buildSandboxSnapFromRaw(target, childRef, cur);
    },
    hasChild(p: string): boolean {
      return this.child(p).exists();
    },
    hasChildren(): boolean { return rows.length > 0; },
    exportVal(): JsonValue { return exportValueAt(target, refForSnap, val).value; },
    toJSON(): JsonValue { return exportValueAt(target, refForSnap, val).value; },
    forEach(cb): boolean {
      for (const { key, value } of rows) {
        const childRef = child(refForSnap, key);
        const childSnap = buildSandboxSnapFromRaw(target, childRef, value);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
  };
  return new DataSnapshot(implementation);
}

function exportValueAt(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  value: JsonValue,
): { value: JsonValue; containsPriority: boolean } {
  if (value === null) return { value: null, containsPriority: false };
  const priority = target.backend.getPriority(refForSnap._path);
  if (typeof value !== 'object' || Array.isArray(value)) {
    return priority === null
      ? { value, containsPriority: false }
      : { value: { '.value': value, '.priority': priority }, containsPriority: true };
  }
  const exported: Record<string, JsonValue> = {};
  let containsPriority = priority !== null;
  const rows = executeQuery(
    value,
    { orderBy: null, bounds: [], limit: null },
    (key) => target.backend.getPriority(child(refForSnap, key)._path),
  );
  for (const { key, value: childValue } of rows) {
    const childExport = exportValueAt(target, child(refForSnap, key), childValue);
    exported[key] = childExport.value;
    containsPriority ||= childExport.containsPriority;
  }
  if (priority !== null) exported['.priority'] = priority;
  return {
    value: containsPriority ? exported : coerceArrays(exported),
    containsPriority,
  };
}
