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
   *  [uid].toSet()`). */
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

  // Per REBUILD_PLAN type table for Set:
  //   difference(other: Set) -> Set
  //   union(other: Set) -> Set
  //   intersection(other: Set) -> Set
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
