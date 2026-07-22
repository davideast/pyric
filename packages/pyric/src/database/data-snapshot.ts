import type { JsonValue } from './sandbox/data-tree.js';
import type { DatabaseReference } from './types.js';

export interface DataSnapshotImplementation {
  readonly key: string | null;
  readonly size: number;
  readonly priority: string | number | null;
  readonly ref: DatabaseReference;
  exists(): boolean;
  val(): JsonValue;
  child(path: string): DataSnapshot;
  hasChild(path: string): boolean;
  hasChildren(): boolean;
  exportVal(): JsonValue;
  toJSON(): JsonValue;
  forEach(cb: (child: DataSnapshot) => boolean | void): boolean;
}

const implementations = new WeakMap<DataSnapshot, DataSnapshotImplementation>();

/** Firebase-shaped RTDB snapshot runtime value. */
export class DataSnapshot {
  readonly ref: DatabaseReference;
  readonly _node: undefined = undefined;
  readonly _index: undefined = undefined;

  constructor(implementation?: DataSnapshotImplementation) {
    if (implementation) implementations.set(this, implementation);
    this.ref = implementation?.ref as DatabaseReference;
  }

  get key(): string | null { return implementations.get(this)?.key ?? null; }
  get size(): number { return implementations.get(this)?.size ?? 0; }
  get priority(): string | number | null { return implementations.get(this)?.priority ?? null; }
  exists(): boolean { return implementations.get(this)?.exists() ?? false; }
  val(): JsonValue { return implementations.get(this)?.val() ?? null; }
  child(path: string): DataSnapshot {
    return implementations.get(this)?.child(path) ?? new DataSnapshot();
  }
  hasChild(path: string): boolean { return implementations.get(this)?.hasChild(path) ?? false; }
  hasChildren(): boolean { return implementations.get(this)?.hasChildren() ?? false; }
  exportVal(): JsonValue { return implementations.get(this)?.exportVal() ?? null; }
  toJSON(): JsonValue { return implementations.get(this)?.toJSON() ?? null; }
  forEach(cb: (child: DataSnapshot) => boolean | void): boolean {
    return implementations.get(this)?.forEach(cb) ?? false;
  }
}

/** Child snapshot supplied during ordered iteration; its key is never null. */
export interface IteratedDataSnapshot extends DataSnapshot {
  readonly key: string;
}
