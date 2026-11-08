/**
 * Structural types and callback normalization for the `pyric-admin/database`
 * mirror of `firebase-admin/database`.
 */

export type EventType = 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';

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
  hasChildren(children?: string[]): boolean;
  numChildren(): number;
  forEach(action: (child: DataSnapshot) => boolean | void): boolean;
  exportVal(): unknown;
  getPriority(): string | number | null;
  toJSON(): unknown;
}

export interface Reference {
  readonly key: string | null;
  readonly parent: Reference | null;
  readonly root: Reference;
  readonly database: Database;
  readonly ref: Reference;
  toString(): string;
  get(): Promise<DataSnapshot>;
  once<T = unknown>(
    eventType: EventType,
    successCallback?: (this: T, snapshot: DataSnapshot, previousChildKey?: string | null) => unknown,
    failureCallbackOrContext?: ((this: T, error: Error) => unknown) | T | null,
    context?: T | null,
  ): Promise<DataSnapshot>;
  set(value: unknown, onComplete?: (error: Error | null) => void): Promise<void>;
  update(values: object, onComplete?: (error: Error | null) => void): Promise<void>;
  remove(onComplete?: (error: Error | null) => void): Promise<void>;
  push(value?: unknown, onComplete?: (error: Error | null) => void): ThenableReference;
  child(path: string): Reference;
  on(
    eventType: EventType,
    callback: (snapshot: DataSnapshot, previousChildKey?: string | null) => unknown,
    cancelCallbackOrContext?: ((error: Error) => unknown) | object | null,
    context?: object | null,
  ): unknown;
  off(
    eventType?: EventType,
    callback?: (snapshot: DataSnapshot, previousChildKey?: string | null) => unknown,
    context?: object | null,
  ): void;
  [key: string]: unknown;
}

export type ThenableReference = Reference & PromiseLike<Reference>;
export type Query = Reference;
export interface OnDisconnect {
  [key: string]: unknown;
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
  const boundContext = context !== undefined ? context : failureCallbackOrContext;
  return { failureCb: undefined, boundContext };
}
