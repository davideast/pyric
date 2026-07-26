/**
 * `pyric/firestore` — public type surface.
 *
 * The cross-cutting handle, reference, query, snapshot, converter, and
 * batch/transaction types shared by every family module. Split out of the
 * former single-file entry (see the barrel `index.ts`) so each family owns
 * its own operations while the shared contract lives in one place.
 *
 * Type-only module apart from the `SandboxError` re-export; carries no
 * operation implementations.
 */

import {
  SandboxError,
  type DocumentData,
  type FieldValueSentinel,
  type LintResult,
  type OrderDirection,
  type WhereFilterOp,
  type WriteBatch as ChainWriteBatch,
  type Transaction as ChainTransaction,
} from 'pyric/sandbox/admin-firestore';
import type { AuthState, Sandbox, SandboxContext } from 'pyric/sandbox';
import type { FirebaseApp } from '../app/types.js';
import { TARGET_SYMBOL, type Target } from './state.js';

/**
 * Pair of translators between the consumer's app model and the
 * underlying Firestore representation. Mirrors `firebase/firestore`'s
 * `FirestoreDataConverter` shape.
 *
 *   - `toFirestore(model)` runs on every write (`setDoc`, `addDoc`)
 *     through a converted ref. Returns the `DocumentData` to send.
 *   - `fromFirestore(snapshot)` runs on every read (`getDoc`,
 *     `getDocs`, snapshot listener callback) through a converted ref.
 *     Receives the raw snapshot, returns the typed model.
 */
export interface FirestoreDataConverter<
  AppModelType,
  DbModelType extends DocumentData = DocumentData,
> {
  toFirestore(modelObject: AppModelType): DbModelType;
  fromFirestore(snapshot: QueryDocumentSnapshot<DbModelType>): AppModelType;
}

// ─── Public Firestore handle ──────────────────────────────────────────

/**
 * Opaque sandbox handle carrying its owner via {@link TARGET_SYMBOL}.
 */
export interface Firestore {
  readonly [TARGET_SYMBOL]: Target;
  readonly app?: FirebaseApp;
}

/** Options accepted by the modular Web-SDK-shaped `runTransaction`. */
export interface TransactionOptions {
  maxAttempts?: number;
}

/** Firestore handle returned by Firebase-shaped app overloads. */
export type AppFirestore = Firestore & { readonly app: FirebaseApp };

// ─── Reference / query types ──────────────────────────────────────────
//
// Modular refs are underlying chainable refs tagged in `refToTarget` so
// operations can recover their sandbox owner.
//
// At the type level, exposing a discriminated union per ref kind would
// be uniformly nice but costs a lot in user-side ergonomics. Instead
// the public types are structural intersections of the operations we
// support; consumer code interacts with refs through our free functions.

/** A reference to a Firestore document. Backend-opaque. */
export interface DocumentReference<_T = DocumentData> {
  readonly id: string;
  readonly path: string;
}
/** A reference to a Firestore collection. Backend-opaque. */
export interface CollectionReference<_T = DocumentData> {
  readonly id: string;
  readonly path: string;
}
/** A Firestore query (a collection ref or one with where/orderBy/limit applied). */
export interface Query<_T = DocumentData> {
  readonly _isQuery?: true;
}
export interface SnapshotMetadata {
  readonly fromCache: boolean;
  readonly hasPendingWrites: boolean;
}
/** A point-in-time view of one document. */
export interface DocumentSnapshot<T = DocumentData> {
  readonly id: string;
  readonly ref: DocumentReference<T>;
  readonly exists: boolean | (() => boolean);
  readonly metadata: SnapshotMetadata;
  data(): T | undefined;
}
/**
 * `QueryDocumentSnapshot` is a `DocumentSnapshot` known to exist —
 * `.data()` always returns the typed model, never `undefined`. Yielded
 * by `QuerySnapshot.docs` and passed to converter `fromFirestore`
 * callbacks. Mirrors the JS SDK's narrowing.
 */
export interface QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  data(): T;
}
/** A point-in-time view of a query result. */
export interface QuerySnapshot<T = DocumentData> {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: ReadonlyArray<QueryDocumentSnapshot<T>>;
  readonly metadata: SnapshotMetadata;
}
export interface WriteBatch extends ChainWriteBatch {}
export interface Transaction extends ChainTransaction {}
export type Unsubscribe = () => void;

export const CACHE_SIZE_UNLIMITED = -1;
export class FirestoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FirestoreError';
  }
}
export class Firestore {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && TARGET_SYMBOL in instance && !('path' in instance) && !('docs' in instance));
  }
}
export class DocumentReference<_T = DocumentData> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(
      instance &&
      typeof instance === 'object' &&
      'id' in instance &&
      'path' in instance &&
      typeof (instance as any).path === 'string' &&
      !('docs' in instance) &&
      !('exists' in instance) &&
      !('doc' in instance) &&
      !('add' in instance)
    );
  }
}
export class CollectionReference<_T = DocumentData> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(
      instance &&
      typeof instance === 'object' &&
      'id' in instance &&
      'path' in instance &&
      typeof (instance as any).path === 'string' &&
      (('doc' in instance) || ('add' in instance))
    );
  }
}
export class Query<_T = DocumentData> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(
      instance &&
      typeof instance === 'object' &&
      (('_isQuery' in instance) || ('where' in instance) || ('orderBy' in instance) || ('doc' in instance) || ('add' in instance))
    );
  }
}
export class DocumentSnapshot<T = DocumentData> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(
      instance &&
      typeof instance === 'object' &&
      'id' in instance &&
      'ref' in instance &&
      'exists' in instance &&
      typeof (instance as any).exists === 'function' &&
      !('docs' in instance)
    );
  }
}
export class QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(
      DocumentSnapshot[Symbol.hasInstance](instance) &&
      typeof (instance as any).data === 'function'
    );
  }
}
export class QuerySnapshot<T = DocumentData> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(
      instance &&
      typeof instance === 'object' &&
      'docs' in instance &&
      'size' in instance &&
      'empty' in instance
    );
  }
}
export class Transaction {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && ('get' in instance || 'set' in instance || 'update' in instance || 'delete' in instance) && !('commit' in instance));
  }
}
export class WriteBatch {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && ('set' in instance || 'update' in instance || 'delete' in instance) && ('commit' in instance));
  }
}
export class SnapshotMetadata {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'fromCache' in instance && 'hasPendingWrites' in instance);
  }
}
export class AbstractUserDataWriter {}

export type {
  AuthState,
  Sandbox,
  SandboxContext,
  DocumentData,
  FieldValueSentinel,
  LintResult,
  OrderDirection,
  WhereFilterOp,
};

export type Primitive = string | number | boolean | bigint | symbol | undefined | null;
export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;
export type UpdateData<T> = { [path in string]: unknown };
export type WithFieldValue<T> = T | Record<string, unknown>;
export type PartialWithFieldValue<T> = Partial<T> | Record<string, unknown>;
export type AddPrefixToKeys<Prefix extends string, T extends Record<string, unknown>> = { [K in keyof T as `${Prefix}.${string & K}`]: T[K] };
export type ChildUpdateFields<T> = Record<string, unknown>;
export type NestedUpdateFields<T> = Record<string, unknown>;
export type DocumentChangeType = 'added' | 'removed' | 'modified';
export interface DocumentChange<T = DocumentData> { readonly type: DocumentChangeType; readonly doc: QueryDocumentSnapshot<T>; readonly oldIndex: number; readonly newIndex: number; }
export type OrderByDirection = 'asc' | 'desc';
export interface EmulatorMockTokenOptions { mockUserToken?: Record<string, unknown> | string; }
export interface ExperimentalLongPollingOptions { forceLongPolling?: boolean; }
export type FirestoreErrorCode = 'cancelled' | 'unknown' | 'invalid-argument' | 'deadline-exceeded' | 'not-found' | 'already-exists' | 'permission-denied' | 'resource-exhausted' | 'failed-precondition' | 'aborted' | 'out-of-range' | 'unimplemented' | 'internal' | 'unavailable' | 'data-loss' | 'unauthenticated';

export { SandboxError };
