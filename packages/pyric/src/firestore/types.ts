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
/** A point-in-time view of one document. */
export interface DocumentSnapshot<T = DocumentData> {
  readonly id: string;
  readonly exists: boolean | (() => boolean);
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
}
export type WriteBatch = ChainWriteBatch;
export type Transaction = ChainTransaction;
export type Unsubscribe = () => void;

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

export { SandboxError };
