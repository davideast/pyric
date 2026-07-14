/**
 * `pyric-admin` — Admin-SDK-shaped chainable Firestore adapter for
 * the Pyric sandbox.
 *
 * `getFirestore(ctx)` returns a `SandboxFirestore` whose operations
 * run under the context's auth identity and against the underlying
 * `LocalEnvironment` of the context's sandbox. Idempotent — a second
 * call with the same `SandboxContext` returns the same wrapper.
 *
 * Wraps the `pyric/sandbox/admin-compat` implementation.
 * Per-operation methods construct a fresh delegate so a
 * `sandbox.reset()` (which swaps the underlying environment) is
 * picked up on the next operation. Refs returned from the wrapper
 * (`DocumentReference`, `Query`) are bound to whichever environment
 * was live when they were obtained — re-acquire them after reset to
 * avoid stale-state confusion.
 *
 * This file is the package export barrel only — re-exports from the
 * concept files in this directory (`get-firestore.ts`,
 * `get-admin-firestore.ts`, `listeners.ts`, `types.ts`,
 * `local-handle.ts`, `error-translation.ts`, `remote/`). No
 * implementation lives here.
 */

// Re-export commonly-needed foundation types so most consumers can
// import everything from `pyric-admin`. Anyone needing more reaches
// into `pyric/sandbox` directly.
export type {
  AuthState,
  Sandbox,
  SandboxContext,
} from 'pyric/sandbox';
export { SandboxError } from 'pyric/sandbox';

// Re-export the production-shaped types so consumers can spell them
// with a `pyric-admin` import path.
//
// `DocumentSnapshot`, `QueryDocumentSnapshot`, `QuerySnapshot` are
// re-exported from the Web-SDK-shaped snapshot-listener types — that's
// what `onSnapshot` callbacks receive and what consumers expect when
// they spell the type. Refs returned by `db.doc()` / `db.collection()`
// also produce data via `.get()`, but those return values use the
// Admin-shaped variants which are exported with `Admin*` prefixes for
// the rare consumer that needs them in the same file.
export type {
  AggregateField,
  AggregateQuerySnapshot,
  AggregateSpec,
  Filter,
  CollectionReference,
  DocumentData,
  DocumentReference,
  DocumentSnapshot as AdminDocumentSnapshot,
  FieldValueSentinel,
  Firestore,
  OrderDirection,
  Query,
  QueryDocumentSnapshot as AdminQueryDocumentSnapshot,
  QuerySnapshot as AdminQuerySnapshot,
  SetOptions,
  Transaction,
  WhereFilterOp,
  WriteBatch,
} from 'pyric/sandbox/admin-compat';
export type { LintResult, LintWarning, RulesMetrics } from 'pyric/rules/internal';
export { FieldValue, Timestamp } from 'pyric/sandbox/admin-compat';

// Web-SDK-shaped snapshot types — what `onSnapshot` callbacks receive.
// Spelled with the conventional Web SDK names so consumers can type
// their callbacks naturally:
//
//   import { onSnapshot, type DocumentSnapshot } from 'pyric-admin/firestore';
//   onSnapshot(db.doc('games/g1'), (snap: DocumentSnapshot) => { ... });
export type {
  LiveDocumentSnapshot as DocumentSnapshot,
  LiveQueryDocumentSnapshot as QueryDocumentSnapshot,
  LiveQuerySnapshot as QuerySnapshot,
  DocumentChange,
  DocumentChangeType,
  DocChangesOptions,
  SnapshotMetadata,
} from 'pyric/sandbox/admin-compat';

// Sandbox-only types — no production analog.
export type { SandboxFirestore } from './types.js';
export type { SnapshotObserver, Unsubscribe } from './types.js';

// Service resolvers.
export { getFirestore } from './get-firestore.js';
export { getAdminFirestore } from './get-admin-firestore.js';

// `onSnapshot` — the free modular-shaped function, its options type, and
// the live-vs-frozen marker the modular `pyric/firestore` layer stamps
// onto listener options (see `listeners.ts`).
export { onSnapshot } from './listeners.js';
export type { SnapshotListenOptions } from './listeners.js';
