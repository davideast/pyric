/**
 * Structural types and callback normalization for the `pyric-admin/database`
 * mirror of `firebase-admin/database`.
 */

export type EventType = 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';

export type SnapshotCallback = (
  snapshot: DataSnapshot,
  previousChildKey?: string | null,
) => unknown;

export interface Database {
  ref(path?: string): Reference;
  refFromURL(url: string): Reference;
  goOffline(): void;
  goOnline(): void;
  getRules(): Promise<string>;
  getRulesJSON(): Promise<object>;
  setRules(source: string | object): Promise<void>;
  readonly app: unknown;
}

export interface DataSnapshot {
  readonly key: string | null;
  readonly ref: Reference;
  val(): unknown;
  exists(): boolean;
  child(path: string): DataSnapshot;
  hasChild(path: string): boolean;
  hasChildren(): boolean;
  numChildren(): number;
  forEach(action: (child: DataSnapshot) => boolean | void): boolean;
  exportVal(): unknown;
  getPriority(): string | number | null;
  toJSON(): unknown;
}

export interface Query {
  readonly ref: Reference;
  toString(): string;
  toJSON(): string;
  isEqual(other: Query | null): boolean;
  get(): Promise<DataSnapshot>;
  once<T = unknown>(
    eventType: EventType,
    successCallback?: (this: T, snapshot: DataSnapshot, previousChildKey?: string | null) => unknown,
    failureCallbackOrContext?: ((this: T, error: Error) => unknown) | T | null,
    context?: T | null,
  ): Promise<DataSnapshot>;
  on(
    eventType: EventType,
    callback: SnapshotCallback,
    cancelCallbackOrContext?: ((error: Error) => unknown) | object | null,
    context?: object | null,
  ): SnapshotCallback;
  off(
    eventType?: EventType,
    callback?: SnapshotCallback,
    context?: object | null,
  ): void;
  orderByChild(path: string): Query;
  orderByKey(): Query;
  orderByPriority(): Query;
  orderByValue(): Query;
  startAt(value?: number | string | boolean | object | null, key?: string): Query;
  startAfter(value: number | string | boolean | object | null | undefined, key?: string): Query;
  endAt(value?: number | string | boolean | object | null, key?: string): Query;
  endBefore(value: number | string | boolean | object | null | undefined, key?: string): Query;
  equalTo(value: number | string | boolean | object | null | undefined, key?: string): Query;
  limitToFirst(limit: number): Query;
  limitToLast(limit: number): Query;
}

export interface Reference extends Query {
  readonly key: string | null;
  readonly parent: Reference | null;
  readonly root: Reference;
  readonly database: Database;
  set(value: unknown, onComplete?: (error: Error | null) => void): Promise<void>;
  update(values: object, onComplete?: (error: Error | null) => void): Promise<void>;
  remove(onComplete?: (error: Error | null) => void): Promise<void>;
  push(value?: unknown, onComplete?: (error: Error | null) => void): ThenableReference;
  child(path: string): Reference;
  onDisconnect(): OnDisconnect;
  transaction(
    transactionUpdate: (currentData: unknown) => unknown,
    onComplete?: (error: Error | null, committed: boolean, snapshot: DataSnapshot | null) => unknown,
    applyLocally?: boolean,
  ): Promise<{ committed: boolean; snapshot: DataSnapshot }>;
  setPriority(
    priority: string | number | null,
    onComplete: (error: Error | null) => unknown,
  ): Promise<void>;
  setWithPriority(
    newVal: unknown,
    newPriority: string | number | null,
    onComplete?: (error: Error | null) => unknown,
  ): Promise<void>;
  [key: string]: unknown;
}

export type ThenableReference = Reference & PromiseLike<Reference>;

export interface OnDisconnect {
  cancel(onComplete?: (error: Error | null) => unknown): Promise<void>;
  remove(onComplete?: (error: Error | null) => unknown): Promise<void>;
  set(value: unknown, onComplete?: (error: Error | null) => unknown): Promise<void>;
  setWithPriority(
    value: unknown,
    priority: number | string | null,
    onComplete?: (error: Error | null) => unknown,
  ): Promise<void>;
  update(values: object, onComplete?: (error: Error | null) => unknown): Promise<void>;
}

/** Minimum JSON value shape stored in the in-memory tree. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Sentinel error thrown by unmodeled listener / transaction / query / priority methods. */
export function notImplemented(method: string): Error {
  return new Error(`pyric-admin/database sandbox: ${method} not implemented`);
}

/** Resolve the 3-arg `(eventType, successCb, context)` vs 4-arg `(..., failureCb, context)` `once` overload. */
export function resolveOnceCallbacks(
  failureCallbackOrContext?: unknown,
  context?: unknown,
): { failureCb: ((error: Error) => unknown) | undefined; boundContext: unknown } {
  if (typeof failureCallbackOrContext === 'function') {
    return {
      failureCb: failureCallbackOrContext as (error: Error) => unknown,
      boundContext: context,
    };
  }
  const hasExplicitContext = context !== undefined;
  const boundContext = hasExplicitContext ? context : failureCallbackOrContext;
  return { failureCb: undefined, boundContext };
}
