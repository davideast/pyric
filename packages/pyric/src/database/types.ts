import type { AuthState, Sandbox, SandboxContext } from 'pyric/sandbox';
import type { FirebaseApp } from '../app/types.js';
import { TARGET_SYMBOL, type Target } from './routing.js';
import type { JsonValue } from './sandbox/data-tree.js';
import type { Constraint, QuerySpec } from './sandbox/query.js';

/** Hidden brand on every Query. */
export const QUERY_SYMBOL: unique symbol = Symbol('pyric/database/query');

/** Hidden brand on every QueryConstraint. */
export const CONSTRAINT_SYMBOL: unique symbol = Symbol('pyric/database/query-constraint');

// ─── Public types ────────────────────────────────────────────────────

/** Opaque RTDB handle. Routes via {@link TARGET_SYMBOL}. */
export class Database {
  readonly [TARGET_SYMBOL]!: Target;
  readonly app?: FirebaseApp;
  readonly type = 'database';
  readonly _instanceStarted = false;

  constructor(target?: Target, app?: FirebaseApp) {
    if (target) this[TARGET_SYMBOL] = target;
    this.app = app;
  }

  get _repo(): undefined { return undefined; }
  get _root(): undefined { return undefined; }
  _delete(): Promise<void> { return Promise.resolve(); }
  _checkNotDeleted(_message?: string): void {}
}

/** Database handle returned by Firebase-shaped app overloads. */
export type AppDatabase = Database & { readonly app: FirebaseApp };

/**
 * RTDB-shaped reference. Backend-opaque to consumers; mirrors
 * `firebase/database`'s `DatabaseReference` for the subset of methods
 * the modular SDK uses idiomatically as plain free-function args.
 *
 * `key` is the last path segment (matches `DatabaseReference.key`).
 * `null` for the root ref. `parent` is the ref one segment up
 * (`null` at root). `root` is always the root ref.
 *
 * `toString()` returns a stable `sandbox://` URL.
 */
export interface DatabaseReference {
  readonly key: string | null;
  readonly parent: DatabaseReference | null;
  readonly root: DatabaseReference;
  toString(): string;
  /** Internal — the canonical path (`'/users/alice'`). */
  readonly _path: string;
}

/**
 * Lightweight `DataSnapshot` — matches the subset of
 * `firebase/database`'s `DataSnapshot` we surface synchronously on a
 * `get()`. Methods are the load-bearing ones (`val`, `exists`, `key`,
 * `child`) plus a few utilities consumer code routinely reads.
 */
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

const dataSnapshotImplementations = new WeakMap<DataSnapshot, DataSnapshotImplementation>();

export class DataSnapshot {
  readonly ref: DatabaseReference;

  constructor(implementation?: DataSnapshotImplementation) {
    if (implementation) dataSnapshotImplementations.set(this, implementation);
    this.ref = implementation?.ref as DatabaseReference;
  }

  get key(): string | null { return dataSnapshotImplementations.get(this)?.key ?? null; }
  /**
   * Number of child properties of this snapshot. A getter (NOT a
   * `numChildren()` method — that was the legacy namespaced API). Locked
   * by oracle `rtdb-modular-get-snapshot-shape.json`
   * (`hasSize: true, hasNumChildren: false`) + upstream
   * `api/Reference_impl.ts:331-333`.
   */
  get size(): number { return dataSnapshotImplementations.get(this)?.size ?? 0; }
  /**
   * The node's priority, or `null`. The sandbox does not model RTDB's
   * priority values, so this is always `null`, matching
   * the common case (no `.priority` set). Mirrors `api/Reference_impl.ts:312`.
   */
  get priority(): string | number | null { return dataSnapshotImplementations.get(this)?.priority ?? null; }
  exists(): boolean { return dataSnapshotImplementations.get(this)?.exists() ?? false; }
  val(): JsonValue { return dataSnapshotImplementations.get(this)?.val() ?? null; }
  child(path: string): DataSnapshot {
    return dataSnapshotImplementations.get(this)?.child(path) ?? new DataSnapshot();
  }
  hasChild(path: string): boolean { return dataSnapshotImplementations.get(this)?.hasChild(path) ?? false; }
  hasChildren(): boolean { return dataSnapshotImplementations.get(this)?.hasChildren() ?? false; }
  /**
   * Like `val()` but includes priority info (for backups). With no
   * priority modeled, this equals `val()`. Mirrors
   * `api/Reference_impl.ts:374-376`.
   */
  exportVal(): JsonValue { return dataSnapshotImplementations.get(this)?.exportVal() ?? null; }
  toJSON(): JsonValue { return dataSnapshotImplementations.get(this)?.toJSON() ?? null; }
  /**
   * Iterate the snapshot's immediate children. The callback is invoked
   * with a child `DataSnapshot` for each child; return `true` to stop
   * iteration early (matches the `firebase/database` contract).
   *
   * For a snapshot built from a {@link Query}, children are visited in
   * the order the query's `orderBy*` constraint computed — the windowed
   * + filtered + limited sequence. For a plain ref snapshot, children
   * are visited in key-insertion order (V8 object iteration order; the
   * RTDB SDK does NOT guarantee an order on plain refs either).
   */
  forEach(cb: (child: DataSnapshot) => boolean | void): boolean {
    return dataSnapshotImplementations.get(this)?.forEach(cb) ?? false;
  }
}

/** Child snapshot supplied during ordered iteration; its key is never null. */
export interface IteratedDataSnapshot extends DataSnapshot {
  readonly key: string;
}

/**
 * The return type of {@link push} — a regular {@link DatabaseReference}
 * with `.then` / `.catch` attached so it can be `await`ed. Mirrors
 * `firebase/database`'s `ThenableReference` (`api/Reference_impl.ts:569`).
 *
 * Critical (DB-B7): the ref + its `.key` are available SYNCHRONOUSLY —
 * the key is minted client-side. The promise covers only the optional
 * value write; a rules-denied write rejects the promise (it does NOT
 * throw synchronously and lose the key). Oracle:
 * `rtdb-push-autoid-format.json`.
 */
export interface ThenableReference extends DatabaseReference {
  then<TResult1 = DatabaseReference, TResult2 = never>(
    onfulfilled?: ((value: DatabaseReference) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<DatabaseReference | TResult>;
}

export type Unsubscribe = () => void;

/** RTDB query: a reference plus its immutable sandbox constraint spec. */
export interface Query {
  readonly ref: DatabaseReference;
  toString(): string;
  readonly _spec: QuerySpec;
  readonly [QUERY_SYMBOL]: true;
}

/** Opaque constraint produced by the order/filter/limit query functions. */
export type QueryConstraintType =
  | 'orderByChild'
  | 'orderByKey'
  | 'orderByPriority'
  | 'orderByValue'
  | 'startAt'
  | 'startAfter'
  | 'endAt'
  | 'endBefore'
  | 'equalTo'
  | 'limitToFirst'
  | 'limitToLast';

export class QueryConstraint {
  readonly type: QueryConstraintType;
  readonly [CONSTRAINT_SYMBOL]!: Constraint;

  constructor(type?: QueryConstraint['type'], internal?: Constraint) {
    this.type = type as QueryConstraint['type'];
    if (internal) this[CONSTRAINT_SYMBOL] = internal;
  }
}

export type EventType =
  | 'value'
  | 'child_added'
  | 'child_changed'
  | 'child_moved'
  | 'child_removed';

export interface ListenOptions {
  readonly onlyOnce?: boolean;
}

type FirebaseSignInProvider =
  | 'custom'
  | 'email'
  | 'password'
  | 'phone'
  | 'anonymous'
  | 'google.com'
  | 'facebook.com'
  | 'github.com'
  | 'twitter.com'
  | 'microsoft.com'
  | 'apple.com';

interface FirebaseIdTokenShape {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  user_id: string;
  auth_time: number;
  provider_id?: 'anonymous';
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  name?: string;
  picture?: string;
  firebase: {
    sign_in_provider: FirebaseSignInProvider;
    identities?: { [provider in FirebaseSignInProvider]?: string[] };
  };
  [claim: string]: unknown;
  uid?: never;
}

export type EmulatorMockTokenOptions = (
  { user_id: string } | { sub: string }
) & Partial<FirebaseIdTokenShape>;

export type { Sandbox, SandboxContext, AuthState, JsonValue };
