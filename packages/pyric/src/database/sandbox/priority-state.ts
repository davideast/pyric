import { joinPath, pathSegments, type JsonValue } from './data-tree.js';
import { priorityBucketIdForSegments } from '../../sandbox/persistence/rtdb-records.js';
import type { Priority } from './query.js';

/** Priorities by canonical path, as {@link PriorityState.atOrBelow} reads them. */
export type PriorityRecord = Record<string, Exclude<Priority, null>>;

function definePriority(target: PriorityRecord, key: string, value: Exclude<Priority, null>): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export class PriorityState {
  private readonly values = new Map<string, Exclude<Priority, null>>();
  private readonly shallowValues = new Map<string, Exclude<Priority, null>>();
  private readonly bucketValues = new Map<string, Map<string, Exclude<Priority, null>>>();
  private readonly bucketListeners = new Set<(bucketId: string) => void>();
  private _generation = 0;
  private _shallowGeneration = 0;

  get size(): number {
    return this.values.size;
  }

  get generation(): number {
    return this._generation;
  }

  get shallowGeneration(): number {
    return this._shallowGeneration;
  }

  onBucketChange(listener: (bucketId: string) => void): () => void {
    this.bucketListeners.add(listener);
    return () => { this.bucketListeners.delete(listener); };
  }

  bucketIds(): IterableIterator<string> {
    return this.bucketValues.keys();
  }

  entriesInBucket(bucketId: string): Iterable<[string, Exclude<Priority, null>]> {
    return this.bucketValues.get(bucketId)?.entries() ?? [];
  }

  shallowRecord(): PriorityRecord {
    const out: PriorityRecord = {};
    const keys = [...this.shallowValues.keys()].sort();
    for (const key of keys) definePriority(out, key, this.shallowValues.get(key)!);
    return out;
  }

  bucketRecord(bucketId: string): PriorityRecord {
    const out: PriorityRecord = {};
    const inner = this.bucketValues.get(bucketId);
    if (inner === undefined) return out;
    const keys = [...inner.keys()].sort();
    for (const key of keys) definePriority(out, key, inner.get(key)!);
    return out;
  }

  private putCanonical(canonical: string, priority: Exclude<Priority, null>): void {
    if (this.values.get(canonical) === priority) return;
    this.values.set(canonical, priority);
    this._generation += 1;
    const bucketId = priorityBucketIdForSegments(pathSegments(canonical));
    if (bucketId === null) {
      this.shallowValues.set(canonical, priority);
      this._shallowGeneration += 1;
      return;
    }
    let inner = this.bucketValues.get(bucketId);
    if (inner === undefined) {
      inner = new Map();
      this.bucketValues.set(bucketId, inner);
    }
    inner.set(canonical, priority);
    for (const listener of this.bucketListeners) listener(bucketId);
  }

  private deleteCanonical(canonical: string): void {
    if (!this.values.has(canonical)) return;
    this.values.delete(canonical);
    this._generation += 1;
    const bucketId = priorityBucketIdForSegments(pathSegments(canonical));
    if (bucketId === null) {
      this.shallowValues.delete(canonical);
      this._shallowGeneration += 1;
      return;
    }
    const inner = this.bucketValues.get(bucketId);
    if (inner !== undefined) {
      inner.delete(canonical);
      if (inner.size === 0) this.bucketValues.delete(bucketId);
    }
    for (const listener of this.bucketListeners) listener(bucketId);
  }

  get(path: string): Priority {
    return this.values.get(joinPath(pathSegments(path))) ?? null;
  }

  forChild(path: string): (key: string) => Priority {
    const base = pathSegments(path);
    return (key) => this.get(joinPath([...base, key]));
  }

  /** The priorities at and below `path`, by canonical path. */
  atOrBelow(path: string): PriorityRecord {
    const canonical = joinPath(pathSegments(path));
    const prefix = canonical === '/' ? '/' : `${canonical}/`;
    const out: PriorityRecord = {};
    for (const [key, priority] of this.values) {
      if (key === canonical || key.startsWith(prefix)) out[key] = priority;
    }
    return out;
  }

  clear(): void {
    if (this.values.size === 0) return;
    const touchedBuckets = [...this.bucketValues.keys()];
    if (this.shallowValues.size > 0) {
      this.shallowValues.clear();
      this._shallowGeneration += 1;
    }
    this.bucketValues.clear();
    this.values.clear();
    this._generation += 1;
    for (const bucketId of touchedBuckets) {
      for (const listener of this.bucketListeners) listener(bucketId);
    }
  }

  clearAtOrBelow(path: string): void {
    const canonical = joinPath(pathSegments(path));
    const prefix = canonical === '/' ? '/' : `${canonical}/`;
    for (const key of [...this.values.keys()]) {
      if (key === canonical || key.startsWith(prefix)) this.deleteCanonical(key);
    }
  }

  replace(path: string, priority: Priority, hasNode?: (path: string) => boolean): void {
    this.clearAtOrBelow(path);
    if (priority !== null) {
      this.putCanonical(joinPath(pathSegments(path)), priority);
      return;
    }
    if (hasNode) this.pruneMissingAncestors(path, hasNode);
  }

  set(path: string, priority: Priority): void {
    const canonical = joinPath(pathSegments(path));
    if (priority === null) this.deleteCanonical(canonical);
    else this.putCanonical(canonical, priority);
  }

  stateAtOrBelow(path: string): string {
    const canonical = joinPath(pathSegments(path));
    const prefix = canonical === '/' ? '/' : `${canonical}/`;
    return JSON.stringify([...this.values]
      .filter(([key]) => key === canonical || key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b)));
  }

  applyUpdate(writes: Array<{ path: string; value: JsonValue }>, hasNode?: (path: string) => boolean): void {
    for (const write of writes) {
      this.clearAtOrBelow(write.path);
      if (write.value === null && hasNode) {
        this.pruneMissingAncestors(write.path, hasNode);
      }
    }
  }

  private pruneMissingAncestors(path: string, hasNode: (path: string) => boolean): void {
    const segments = pathSegments(path);
    for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
      const ancestor = joinPath(segments.slice(0, depth));
      if (hasNode(ancestor)) break;
      this.deleteCanonical(ancestor);
    }
  }

  entries(): IterableIterator<[string, Exclude<Priority, null>]> {
    return this.values.entries();
  }

  restore(values: Record<string, Exclude<Priority, null>>): void {
    this.clear();
    for (const [path, priority] of Object.entries(values)) {
      this.putCanonical(joinPath(pathSegments(path)), priority);
    }
  }
}

export function validatePriority(priority: Priority): void {
  if (
    priority !== null
    && typeof priority !== 'string'
    && (typeof priority !== 'number' || !Number.isFinite(priority))
  ) {
    throw new Error('priority must be a valid Firebase priority (string, finite number, or null)');
  }
}
