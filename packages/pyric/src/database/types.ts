import type { AuthState, Sandbox, SandboxContext } from 'pyric/sandbox';
import { QUERY_SYMBOL } from './brands.js';
import type { Database } from './database-handle.js';
import type { DataSnapshot } from './data-snapshot.js';
import type { JsonValue } from './sandbox/data-tree.js';
import type { QuerySpec } from './sandbox/query.js';

export { CONSTRAINT_SYMBOL, QUERY_SYMBOL } from './brands.js';
export { Database } from './database-handle.js';
export type { AppDatabase } from './database-handle.js';
export { DataSnapshot } from './data-snapshot.js';
export type { DataSnapshotImplementation, IteratedDataSnapshot } from './data-snapshot.js';
export { QueryConstraint } from './query-constraint.js';
export type { QueryConstraintType } from './query-constraint.js';

// ─── Public types ────────────────────────────────────────────────────

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
export interface Query {
  readonly ref: DatabaseReference;
  isEqual(other: Query | null): boolean;
  toJSON(): string;
  toString(): string;
  readonly _spec: QuerySpec;
  readonly [QUERY_SYMBOL]: true;
}

export interface DatabaseReference extends Query {
  readonly key: string | null;
  readonly parent: DatabaseReference | null;
  readonly root: DatabaseReference;
  /** Internal — the canonical path (`'/users/alice'`). */
  readonly _path: string;
}

/**
 * Lightweight `DataSnapshot` — matches the subset of
 * `firebase/database`'s `DataSnapshot` we surface synchronously on a
 * `get()`. Methods are the load-bearing ones (`val`, `exists`, `key`,
 * `child`) plus a few utilities consumer code routinely reads.
 */
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
