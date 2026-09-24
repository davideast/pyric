/**
 * MapDiff implementation for Firestore rules simulation.
 *
 * Implements request.resource.data.diff(resource.data) which returns
 * a MapDiff object with methods for comparing two document states.
 *
 * Semantics derived from production Firestore behavior:
 * - Only compares top-level keys (nested map diff is unreliable in production)
 * - Values are compared with Firestore Rules value equality
 * - Keys are own keys only, so a key named `constructor` or `toString` is
 *   added or removed like any other (production maps expose no prototype)
 * - Returns Set-like objects with hasOnly(), hasAll(), hasAny(), size()
 */

import { FirestoreSet } from './firestore-set.js';
import { rulesValuesEqual } from './value-equality.js';

export { FirestoreSet } from './firestore-set.js';

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
      if (!Object.hasOwn(this.before, key)) added.push(key);
    }
    return new FirestoreSet(added);
  }

  /** Keys present in `before` but not in `after`. */
  removedKeys(): FirestoreSet {
    const removed: string[] = [];
    for (const key of Object.keys(this.before)) {
      if (!Object.hasOwn(this.after, key)) removed.push(key);
    }
    return new FirestoreSet(removed);
  }

  /** Keys present in both but with different values. */
  changedKeys(): FirestoreSet {
    const changed: string[] = [];
    for (const key of Object.keys(this.after)) {
      if (Object.hasOwn(this.before, key) && !rulesValuesEqual(this.before[key], this.after[key])) {
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
      if (!Object.hasOwn(this.before, key) || !Object.hasOwn(this.after, key) || !rulesValuesEqual(this.before[key], this.after[key])) {
        affected.push(key);
      }
    }
    return new FirestoreSet(affected);
  }

  /** Keys present in both with identical values. */
  unchangedKeys(): FirestoreSet {
    const unchanged: string[] = [];
    for (const key of Object.keys(this.before)) {
      if (Object.hasOwn(this.after, key) && rulesValuesEqual(this.before[key], this.after[key])) {
        unchanged.push(key);
      }
    }
    return new FirestoreSet(unchanged);
  }
}
