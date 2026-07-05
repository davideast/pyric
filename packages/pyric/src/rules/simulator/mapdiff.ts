/**
 * MapDiff implementation for Firestore rules simulation.
 *
 * Implements request.resource.data.diff(resource.data) which returns
 * a MapDiff object with methods for comparing two document states.
 *
 * Semantics derived from production Firestore behavior:
 * - Only compares top-level keys (nested map diff is unreliable in production)
 * - Values are compared with deep equality
 * - Returns Set-like objects with hasOnly(), hasAll(), hasAny(), size()
 */

export class FirestoreSet {
  private items: Set<string>;

  constructor(items: Iterable<string>) {
    this.items = new Set(items);
  }

  /** True if the set contains ONLY keys from the provided list/set (and no others). */
  hasOnly(keys: string[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    for (const item of this.items) {
      if (!arr.includes(item)) return false;
    }
    return true;
  }

  /** Value equality against another FirestoreSet (order-insensitive).
   *  Production supports `set == set` (e.g. `diff.addedKeys() ==
   *  [uid].toSet()`); without this the evaluator's deep-equals fell
   *  into the generic-object branch, whose Object.keys() view of the
   *  private JS Set is always [] — so ANY two sets compared EQUAL, a
   *  false-PERMISSIVE divergence found by joining validation. */
  equals(other: unknown): boolean {
    if (!(other instanceof FirestoreSet)) return false;
    if (other.items.size !== this.items.size) return false;
    for (const item of this.items) {
      if (!other.items.has(item)) return false;
    }
    return true;
  }

  /** True if the set contains ALL keys from the provided list/set. */
  hasAll(keys: string[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    for (const key of arr) {
      if (!this.items.has(key)) return false;
    }
    return true;
  }

  /** True if the set contains ANY key from the provided list/set. */
  hasAny(keys: string[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    for (const key of arr) {
      if (this.items.has(key)) return true;
    }
    return false;
  }

  /** Number of items in the set. */
  size(): number {
    return this.items.size;
  }

  /** Convert to array (for debugging). */
  toArray(): string[] {
    return [...this.items];
  }

  // ─── Set algebra (Item 5.1) ───────────────────────────────────────────
  // Per REBUILD_PLAN type table for Set:
  //   difference(other: Set) → Set
  //   union(other: Set) → Set
  //   intersection(other: Set) → Set
  // Mirroring hasOnly/hasAll/hasAny, we accept a List (string[]) too.

  /** Items in this set but not in `other`. */
  difference(other: string[] | FirestoreSet): FirestoreSet {
    const otherSet = new Set(other instanceof FirestoreSet ? other.toArray() : other);
    const result: string[] = [];
    for (const item of this.items) {
      if (!otherSet.has(item)) result.push(item);
    }
    return new FirestoreSet(result);
  }

  /** Items in either set. */
  union(other: string[] | FirestoreSet): FirestoreSet {
    const otherArr = other instanceof FirestoreSet ? other.toArray() : other;
    const merged = new Set<string>(this.items);
    for (const item of otherArr) merged.add(item);
    return new FirestoreSet(merged);
  }

  /** Items in both sets. */
  intersection(other: string[] | FirestoreSet): FirestoreSet {
    const otherSet = new Set(other instanceof FirestoreSet ? other.toArray() : other);
    const result: string[] = [];
    for (const item of this.items) {
      if (otherSet.has(item)) result.push(item);
    }
    return new FirestoreSet(result);
  }
}

export class MapDiff {
  private before: Record<string, unknown>;
  private after: Record<string, unknown>;

  constructor(before: Record<string, unknown>, after: Record<string, unknown>) {
    this.before = before;
    this.after = after;
  }

  /** Keys present in `after` but not in `before`. */
  addedKeys(): FirestoreSet {
    const added: string[] = [];
    for (const key of Object.keys(this.after)) {
      if (!(key in this.before)) added.push(key);
    }
    return new FirestoreSet(added);
  }

  /** Keys present in `before` but not in `after`. */
  removedKeys(): FirestoreSet {
    const removed: string[] = [];
    for (const key of Object.keys(this.before)) {
      if (!(key in this.after)) removed.push(key);
    }
    return new FirestoreSet(removed);
  }

  /** Keys present in both but with different values. */
  changedKeys(): FirestoreSet {
    const changed: string[] = [];
    for (const key of Object.keys(this.after)) {
      if (key in this.before && !deepEqual(this.before[key], this.after[key])) {
        changed.push(key);
      }
    }
    return new FirestoreSet(changed);
  }

  /** Keys that were added, removed, or changed. Union of added + removed + changed. */
  affectedKeys(): FirestoreSet {
    const affected: string[] = [];
    const allKeys = new Set([...Object.keys(this.before), ...Object.keys(this.after)]);
    for (const key of allKeys) {
      if (!(key in this.before) || !(key in this.after) || !deepEqual(this.before[key], this.after[key])) {
        affected.push(key);
      }
    }
    return new FirestoreSet(affected);
  }

  /** Keys present in both with identical values. */
  unchangedKeys(): FirestoreSet {
    const unchanged: string[] = [];
    for (const key of Object.keys(this.before)) {
      if (key in this.after && deepEqual(this.before[key], this.after[key])) {
        unchanged.push(key);
      }
    }
    return new FirestoreSet(unchanged);
  }
}

/** Deep equality for Firestore field values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (Array.isArray(a) || Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => key in bObj && deepEqual(aObj[key], bObj[key]));
}
