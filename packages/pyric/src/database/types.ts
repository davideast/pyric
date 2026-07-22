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
export interface Database {
  readonly [TARGET_SYMBOL]: Target;
  readonly app?: FirebaseApp;
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
export interface DataSnapshot {
  readonly key: string | null;
  /**
   * Number of child properties of this snapshot. A getter (NOT a
   * `numChildren()` method — that was the legacy namespaced API). Locked
   * by oracle `rtdb-modular-get-snapshot-shape.json`
   * (`hasSize: true, hasNumChildren: false`) + upstream
   * `api/Reference_impl.ts:331-333`.
   */
  readonly size: number;
  /**
   * The node's priority, or `null`. The sandbox does not model RTDB's
   * priority values, so this is always `null`, matching
   * the common case (no `.priority` set). Mirrors `api/Reference_impl.ts:312`.
   */
  readonly priority: string | number | null;
  exists(): boolean;
  val(): JsonValue;
  child(path: string): DataSnapshot;
  hasChild(path: string): boolean;
  hasChildren(): boolean;
  /**
   * Like `val()` but includes priority info (for backups). With no
   * priority modeled, this equals `val()`. Mirrors
   * `api/Reference_impl.ts:374-376`.
   */
  exportVal(): JsonValue;
  toJSON(): JsonValue;
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
  forEach(cb: (child: DataSnapshot) => boolean | void): boolean;
  /** The ref the snap was taken from. */
  readonly ref: DatabaseReference;
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
export interface QueryConstraint {
  readonly type:
    | 'orderByChild'
    | 'orderByKey'
    | 'orderByValue'
    | 'startAt'
    | 'startAfter'
    | 'endAt'
    | 'endBefore'
    | 'equalTo'
    | 'limitToFirst'
    | 'limitToLast';
  readonly [CONSTRAINT_SYMBOL]: Constraint;
}

export type { Sandbox, SandboxContext, AuthState, JsonValue };
