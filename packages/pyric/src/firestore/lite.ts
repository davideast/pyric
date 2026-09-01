/**
 * `pyric/firestore/lite` — a DEFERRED mirror of `firebase/firestore/lite`.
 *
 * The Lite SDK is a separate build of Firestore with no local cache, no
 * listeners and no offline queue. pyric mirrors the full `firebase/firestore`
 * surface against the in-process sandbox; the Lite build needs its own
 * cache-free instance identity, so it is deferred rather than aliased — an
 * alias would silently give Lite consumers listener-backed semantics the real
 * Lite SDK does not have.
 *
 * Every symbol below resolves and links so an app that swaps `firebase` for
 * `pyric` still loads; touching one throws `PyricDeferredApiError` naming this
 * subpath. See `../deferred/entry.ts` for the full rationale.
 *
 * The value list is the exact public runtime surface of `firebase/firestore/lite`
 * (Firebase Web SDK 12.13.0). Keep it in sync when this entry graduates to a
 * real mirror.
 */
import { deferredEntry, type DeferredApi } from '../deferred/entry.js';

export { PyricDeferredApiError } from '../deferred/entry.js';

export const {
  AggregateField, AggregateQuerySnapshot, Bytes, CollectionReference, DocumentReference,
  DocumentSnapshot, FieldPath, FieldValue, Firestore, FirestoreError, GeoPoint, Query,
  QueryCompositeFilterConstraint, QueryConstraint, QueryDocumentSnapshot, QueryEndAtConstraint,
  QueryFieldFilterConstraint, QueryLimitConstraint, QueryOrderByConstraint, QuerySnapshot,
  QueryStartAtConstraint, Timestamp, Transaction, VectorValue, WriteBatch, addDoc,
  aggregateFieldEqual, aggregateQuerySnapshotEqual, and, arrayRemove, arrayUnion, average,
  collection, collectionGroup, connectFirestoreEmulator, count, deleteDoc, deleteField, doc,
  documentId, endAt, endBefore, getAggregate, getCount, getDoc, getDocs, getFirestore,
  increment, initializeFirestore, limit, limitToLast, or, orderBy, query, queryEqual, refEqual,
  runTransaction, serverTimestamp, setDoc, setLogLevel, snapshotEqual, startAfter, startAt,
  sum, terminate, updateDoc, vector, where, writeBatch,
} = deferredEntry('firestore/lite');

// Type declarations. Aliased to the deferred placeholder so a consumer's own
// annotations keep type-checking: every deferred call returns `never`, which is
// assignable to any of these. Names that Firebase exports as a CLASS appear both
// here and above — a class is a value and a type, and both meanings must survive
// the swap.
export type AddPrefixToKeys = DeferredApi;
export type AggregateField = DeferredApi;
export type AggregateFieldType = DeferredApi;
export type AggregateQuerySnapshot = DeferredApi;
export type AggregateSpec = DeferredApi;
export type AggregateSpecData = DeferredApi;
export type AggregateType = DeferredApi;
export type Bytes = DeferredApi;
export type ChildUpdateFields = DeferredApi;
export type CollectionReference = DeferredApi;
export type DocumentData = DeferredApi;
export type DocumentReference = DeferredApi;
export type DocumentSnapshot = DeferredApi;
export type EmulatorMockTokenOptions = DeferredApi;
export type FieldPath = DeferredApi;
export type FieldValue = DeferredApi;
export type Firestore = DeferredApi;
export type FirestoreDataConverter = DeferredApi;
export type FirestoreError = DeferredApi;
export type FirestoreErrorCode = DeferredApi;
export type GeoPoint = DeferredApi;
export type LogLevel = DeferredApi;
export type NestedUpdateFields = DeferredApi;
export type OrderByDirection = DeferredApi;
export type PartialWithFieldValue = DeferredApi;
export type Primitive = DeferredApi;
export type Query = DeferredApi;
export type QueryCompositeFilterConstraint = DeferredApi;
export type QueryConstraint = DeferredApi;
export type QueryConstraintType = DeferredApi;
export type QueryDocumentSnapshot = DeferredApi;
export type QueryEndAtConstraint = DeferredApi;
export type QueryFieldFilterConstraint = DeferredApi;
export type QueryFilterConstraint = DeferredApi;
export type QueryLimitConstraint = DeferredApi;
export type QueryNonFilterConstraint = DeferredApi;
export type QueryOrderByConstraint = DeferredApi;
export type QuerySnapshot = DeferredApi;
export type QueryStartAtConstraint = DeferredApi;
export type SetOptions = DeferredApi;
export type Settings = DeferredApi;
export type Timestamp = DeferredApi;
export type Transaction = DeferredApi;
export type TransactionOptions = DeferredApi;
export type UnionToIntersection = DeferredApi;
export type UpdateData = DeferredApi;
export type VectorValue = DeferredApi;
export type WhereFilterOp = DeferredApi;
export type WithFieldValue = DeferredApi;
export type WriteBatch = DeferredApi;
