/**
 * `@pyric/sandbox/admin-compat` — chainable Admin-shaped Firestore
 * wrapper backed by `LocalEnvironment`.
 *
 * This is the surface that mirrors `firebase-admin/firestore` (the
 * Admin Node SDK) so test + agent code that's written against the
 * chainable Admin shape — `db.collection('x').doc('y').get()` etc. —
 * can run unmodified against the in-process sandbox.
 *
 * `@pyric/admin` imports from here directly rather than reaching across
 * packages for its substrate.
 *
 * Exported as a separate subpath (not via `/internal`) because the
 * admin-compat surface has its own `DocumentData` / `Transaction` /
 * etc. types that would collide with the local-environment exports
 * already on `/internal`.
 */

export * from './firestore/admin-compat/index.js';

// Web-SDK-shaped snapshot aliases — what onSnapshot listener callbacks
// receive. Re-exported here with `Live*` prefixes to disambiguate from
// admin-compat's own DocumentSnapshot / QuerySnapshot (chainable Admin
// shape). Consumers (e.g. `@pyric/admin`) augment THIS module's
// LiveDocumentSnapshot / LiveQuerySnapshot to attach `onSnapshot` methods.
export type {
  DocumentSnapshot as LiveDocumentSnapshot,
  QueryDocumentSnapshot as LiveQueryDocumentSnapshot,
  QuerySnapshot as LiveQuerySnapshot,
  DocumentChange,
  DocumentChangeType,
  DocChangesOptions,
  SnapshotMetadata,
  SnapshotDocRef,
  SnapshotQueryRef,
  SnapshotTarget,
  QueryConstraintApplier,
  SnapshotListenerOptions,
} from './internal/index.js';
