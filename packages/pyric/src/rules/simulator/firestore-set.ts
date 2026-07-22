import { rulesValuesEqual } from './value-equality.js';

export class FirestoreSet {
  private items: unknown[];

  constructor(items: Iterable<unknown>) {
    this.items = [];
    for (const item of items) {
      if (!this.items.some((existing) => rulesValuesEqual(existing, item))) this.items.push(item);
    }
  }

  /** True if the set contains ONLY keys from the provided list/set (and no others). */
  hasOnly(keys: unknown[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    return this.items.every((item) => arr.some((key) => rulesValuesEqual(item, key)));
  }

  /** Value equality against another FirestoreSet (order-insensitive).
   *  Production supports `set == set` (e.g. `diff.addedKeys() ==
   *  [uid].toSet()`). */
  equals(other: unknown): boolean {
    if (!(other instanceof FirestoreSet)) return false;
    if (other.items.length !== this.items.length) return false;
    return this.items.every((item) => other.items.some((candidate) => rulesValuesEqual(item, candidate)));
  }

  /** True if the set contains ALL keys from the provided list/set. */
  hasAll(keys: unknown[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    for (const key of arr) {
      if (!this.items.some((item) => rulesValuesEqual(item, key))) return false;
    }
    return true;
  }

  /** True if the set contains ANY key from the provided list/set. */
  hasAny(keys: unknown[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    for (const key of arr) {
      if (this.items.some((item) => rulesValuesEqual(item, key))) return true;
    }
    return false;
  }

  /** Number of items in the set. */
  size(): number {
    return this.items.length;
  }

  /** Convert to array (for debugging). */
  toArray(): unknown[] {
    return [...this.items];
  }

  // Per REBUILD_PLAN type table for Set:
  //   difference(other: Set) -> Set
  //   union(other: Set) -> Set
  //   intersection(other: Set) -> Set
  // Production requires a Set argument for algebra (unlike membership methods,
  // which also accept Lists). The evaluator enforces that receiver boundary.

  /** Items in this set but not in `other`. */
  difference(other: FirestoreSet): FirestoreSet {
    const otherItems = other.toArray();
    const result: unknown[] = [];
    for (const item of this.items) {
      if (!otherItems.some((candidate) => rulesValuesEqual(item, candidate))) result.push(item);
    }
    return new FirestoreSet(result);
  }

  /** Items in either set. */
  union(other: FirestoreSet): FirestoreSet {
    const otherArr = other.toArray();
    return new FirestoreSet([...this.items, ...otherArr]);
  }

  /** Items in both sets. */
  intersection(other: FirestoreSet): FirestoreSet {
    const otherItems = other.toArray();
    const result: unknown[] = [];
    for (const item of this.items) {
      if (otherItems.some((candidate) => rulesValuesEqual(item, candidate))) result.push(item);
    }
    return new FirestoreSet(result);
  }
}
