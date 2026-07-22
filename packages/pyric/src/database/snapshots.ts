import { coerceArrays } from './sandbox/normalize.js';
import { pathSegments, type JsonValue } from './sandbox/data-tree.js';
import type { QueryRow } from './sandbox/query.js';
import type { SandboxLiveTarget, SandboxTarget } from './routing.js';
import type { DataSnapshot, DatabaseReference } from './types.js';
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
  _target: SandboxTarget | SandboxLiveTarget,
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
  return {
    key: refForSnap.key,
    ref: refForSnap,
    size: childCount,
    priority: null,
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
      return buildSandboxSnapFromRaw(_target, childRef, cur);
    },
    hasChild(p: string): boolean {
      return this.child(p).exists();
    },
    hasChildren(): boolean {
      return val !== null && typeof val === 'object' && !Array.isArray(val)
        && Object.keys(val as Record<string, JsonValue>).length > 0;
    },
    exportVal(): JsonValue { return coerced; },
    toJSON(): JsonValue { return coerced; },
    forEach(cb): boolean {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
      for (const [k, v] of Object.entries(val as Record<string, JsonValue>)) {
        const childRef = child(refForSnap, k);
        const childSnap = buildSandboxSnapFromRaw(_target, childRef, v);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
  };
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
  return {
    key: refForSnap.key,
    ref: refForSnap,
    size: rows.length,
    priority: null,
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
    exportVal(): JsonValue { return coerced; },
    toJSON(): JsonValue { return coerced; },
    forEach(cb): boolean {
      for (const { key, value } of rows) {
        const childRef = child(refForSnap, key);
        const childSnap = buildSandboxSnapFromRaw(target, childRef, value);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
  };
}
