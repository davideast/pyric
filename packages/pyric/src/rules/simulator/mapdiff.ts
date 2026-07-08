/**
 * MapDiff implementation for Firestore rules simulation.
 *
 * Implements request.resource.data.diff(resource.data) which returns
 * a MapDiff object with methods for comparing two document states.
 *
 * Semantics derived from production Firestore behavior:
 * - Only compares top-level keys (nested map diff is unreliable in production)
 * - Values are compared with Firestore Rules value equality
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
      if (key in this.before && !rulesValuesEqual(this.before[key], this.after[key])) {
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
      if (!(key in this.before) || !(key in this.after) || !rulesValuesEqual(this.before[key], this.after[key])) {
        affected.push(key);
      }
    }
    return new FirestoreSet(affected);
  }

  /** Keys present in both with identical values. */
  unchangedKeys(): FirestoreSet {
    const unchanged: string[] = [];
    for (const key of Object.keys(this.before)) {
      if (key in this.after && rulesValuesEqual(this.before[key], this.after[key])) {
        unchanged.push(key);
      }
    }
    return new FirestoreSet(unchanged);
  }
}
