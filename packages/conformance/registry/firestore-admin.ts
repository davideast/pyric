import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilityTableBlock } from './types.ts';

const SECTION = 'firebase-admin `getFirestore()` (`pyric-admin/firestore`)';

const adminRow = defineRows({
  surface: 'firestore-admin',
  defaults: {
    section: SECTION,
  },
});

const firestoreAdminRows: CompatibilityRow[] = [
  adminRow({
    rowRef: '1',
    featureKeys: ['getFirestore'],
    api: 'getFirestore() (default app resolution and app/no-app)',
    behavior:
      'Calling `getFirestore()` with no argument resolves the initialized `[DEFAULT]` `PyricAdminApp` to an Admin `Firestore` handle, and throws `FirebaseAppError` `app/no-app` with the upstream `[DEFAULT]` message when no default app exists.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: [
      'admin-app-accessors-resolve-default',
      'admin-app-no-app-error',
    ],
    conformanceTests: [
      'packages/pyric-admin/test/app/oracle-conformance.test.ts',
      'packages/pyric-admin/test/app/default-service-app.test.ts',
      'packages/pyric-admin/test/firestore/firestore/get-firestore.test.ts',
    ],
    evidence:
      'Production captures `admin-app-accessors-resolve-default` and `admin-app-no-app-error` (firebase-admin 13.10.0) replayed by `oracle-conformance.test.ts`, `default-service-app.test.ts`, and `get-firestore.test.ts`.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts default-app resolution and app/no-app error code'],
  }),
  adminRow({
    rowRef: '1a',
    featureKeys: ['getFirestore'],
    api: 'getFirestore(app) (rules-bypass routing, per-app handle caching, and post-deleteApp rejection)',
    behavior:
      'Resolves an explicit `PyricAdminApp` to a rules-bypassing Admin `Firestore` handle across in-process and remote worker sandboxes, caches one handle per active app (`getFirestore(app) === getFirestore(app)`), rejects non-`PyricAdminApp` inputs with `TypeError`, and rejects `getFirestore(app)` and retained-handle operations after `deleteApp(app)`.',
    status: 'conforms',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/firestore/firestore/admin-bypass.test.ts',
      'packages/pyric-admin/test/firestore/app-brand-validation.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore.test.ts',
      'packages/pyric-admin/test/app/registry.test.ts',
    ],
    evidence:
      'Verified across local and remote arms in `admin-bypass.test.ts`, `app-brand-validation.test.ts`, `remote-firestore.test.ts`, and `registry.test.ts`; no standalone production capture records rules-bypass or post-delete service calls.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts rules-bypass semantics, handle caching, and app/app-deleted'],
  }),
  adminRow({
    rowRef: '2',
    featureKeys: ['Firestore.databaseId'],
    api: 'getFirestore(app, databaseId) and Firestore.databaseId',
    behavior:
      'Production isolates documents, batches, and transactions per named Firestore database (`firestore-named-database-admin-mixing`) and exposes `db.databaseId`; `pyric-admin/firestore` does not yet support selecting or isolating a non-default `databaseId` and omits `db.databaseId`.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Named Firestore database selection, per-database storage isolation, and Firestore.databaseId are not yet implemented in pyric-admin/firestore.',
    oracleObservations: ['firestore-named-database-admin-mixing'],
    conformanceTests: [
      'packages/pyric-admin/test/firestore/named-database.test.ts',
      'packages/pyric-admin/test/surface/admin-surface.test.ts',
    ],
    evidence:
      'Production capture `firestore-named-database-admin-mixing` records cross-database isolation; `named-database.test.ts` and `admin-surface.test.ts` pin the single-database boundary.',
  }),
  adminRow({
    rowRef: '3',
    featureKeys: [
      'Firestore.collection',
      'Firestore.doc',
      'CollectionReference.doc',
      'CollectionReference.add',
    ],
    api: 'db.collection(path) / db.doc(path) / col.doc(id?) / col.add(data)',
    behavior:
      'Validates odd/even slash-delimited collection and document paths, mints 20-character auto-IDs when `col.doc()` omits `id` or on `col.add(data)`, and navigates nested subcollections via `docRef.collection(name)` across local and remote arms.',
    status: 'conforms',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/firestore/firestore/sandbox-ops.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
    ],
    evidence:
      'Verified across local and remote arms in `sandbox-ops.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`; no dedicated admin production capture.',
    risk: ['specific-value'],
    riskScore: 2,
    riskReasons: ['asserts path parity and auto-ID format'],
  }),
  adminRow({
    rowRef: '4',
    featureKeys: [
      'DocumentReference.get',
      'DocumentReference.create',
      'DocumentReference.set',
      'DocumentReference.update',
      'DocumentReference.delete',
    ],
    api: 'docRef.get() / create(data) / set(data, options?) / update(...) / delete()',
    behavior:
      'Executes chainable document CRUD across local and remote arms (`create` rejects existing documents with `already-exists`, `set` replaces or merges, `update` accepts object maps or field/value pairs and rejects missing documents with `not-found`, and `delete` succeeds idempotently on missing documents), but `create`, `set`, `update`, and `delete` resolve to `undefined` rather than `WriteResult` (`{ writeTime }`), and `Precondition` options on `update`/`delete` are not modeled.',
    status: 'diverged-documented',
    statusNote:
      'create, set, update, and delete resolve to undefined instead of WriteResult ({ writeTime }), and Precondition options on update/delete are not modeled',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/firestore/firestore/sandbox-ops.test.ts',
      'packages/pyric-admin/test/firestore/firestore/deletedoc-missing.test.ts',
      'packages/pyric-admin/test/firestore/firestore/error-translation.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
    ],
    evidence:
      'Pinned across local and remote arms in `sandbox-ops.test.ts`, `deletedoc-missing.test.ts`, `error-translation.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts create/update error codes, merge semantics, and void return divergence'],
  }),
  adminRow({
    rowRef: '5',
    featureKeys: ['DocumentSnapshot.exists', 'DocumentSnapshot.data', 'DocumentSnapshot.get'],
    api: 'DocumentSnapshot.exists / data() / get(fieldPath)',
    behavior:
      'Exposes boolean `exists`, defensive-cloned `data()` (`undefined` when absent), and `get(fieldPath)` across one-shot, query, transaction, and listener snapshots for dotted field paths, literal-dot `FieldPath` segments, missing fields, and synchronous invalid-path validation.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['admin-firestore-document-snapshot-get'],
    conformanceTests: [
      'packages/pyric-admin/test/firestore/firestore/document-snapshot-get.test.ts',
      'packages/pyric-admin/test/firestore/snapshot-immutability.test.ts',
    ],
    evidence:
      'Production capture `admin-firestore-document-snapshot-get` (firebase-admin 13.10.0) replayed across all six read/listener surfaces by `document-snapshot-get.test.ts`, plus clone isolation in `snapshot-immutability.test.ts`.',
    risk: ['specific-value', 'error-code'],
    riskScore: 3,
    riskReasons: ['asserts field-path traversal and invalid-path throws'],
  }),
  adminRow({
    rowRef: '6',
    featureKeys: [
      'FieldValue.serverTimestamp',
      'FieldValue.increment',
      'FieldValue.arrayUnion',
      'FieldValue.arrayRemove',
      'FieldValue.delete',
      'FieldPath',
      'Timestamp',
    ],
    api: 'FieldValue.{serverTimestamp, increment, arrayUnion, arrayRemove, delete} / FieldPath / Timestamp / Uint8Array / DocumentReference values',
    behavior:
      'Supports `FieldValue.serverTimestamp()`, `increment()`, `arrayUnion()`, `arrayRemove()`, and `delete()`, `FieldPath` construction and `FieldPath.documentId()`, `Timestamp` range validation and round-trip, byte buffers, and stored `DocumentReference` values across local and remote arms (`FieldValue.vector` is absent; see `#10`).',
    status: 'conforms',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/firestore/reference-and-bytes-fields.test.ts',
      'packages/pyric-admin/test/firestore/field-path-queries.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
    ],
    evidence:
      'Verified across local and remote arms in `reference-and-bytes-fields.test.ts`, `field-path-queries.test.ts`, and `remote-firestore-parity.test.ts`.',
    risk: ['specific-value'],
    riskScore: 2,
    riskReasons: ['asserts sentinel transforms and value-type round-trips'],
  }),
  adminRow({
    rowRef: '7',
    featureKeys: [
      'Firestore.collectionGroup',
      'Query.where',
      'Query.orderBy',
      'Query.limit',
      'Query.limitToLast',
    ],
    api: 'Query.where / orderBy / limit / limitToLast / aggregate / collectionGroup and onSnapshot',
    behavior:
      'Filters, orders, limits, aggregates (`count`, `sum`, `average` via `query.aggregate(spec)`), scans collection groups, and streams `QuerySnapshot` / `DocumentSnapshot` updates across local and remote arms; composite `Filter` is deferred and cursor helpers are exposed as `startCursor`/`endCursor` rather than `startAt`/`startAfter`/`endAt`/`endBefore`.',
    status: 'diverged-documented',
    statusNote:
      'Filter is deferred, query.aggregate(spec) resolves directly without .get(), and cursors use startCursor/endCursor rather than startAt/startAfter/endAt/endBefore',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/firestore/field-path-queries.test.ts',
      'packages/pyric-admin/test/firestore/firestore/onSnapshot.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
    ],
    evidence:
      'Pinned across local and remote arms in `field-path-queries.test.ts`, `onSnapshot.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
    risk: ['listener', 'specific-value'],
    riskScore: 3,
    riskReasons: ['asserts query filtering, ordering, and listener delivery'],
  }),
  adminRow({
    rowRef: '8',
    featureKeys: [
      'Firestore.batch',
      'WriteBatch.commit',
      'Firestore.runTransaction',
      'Transaction.get',
    ],
    api: 'db.batch() and db.runTransaction(fn, opts)',
    behavior:
      'Commits atomic `WriteBatch` mutations (`create`, `set`, `update`, `delete`, `commit`) and optimistic-concurrency transactions supporting `tx.get(docRef)` and `tx.get(query)` across local and remote arms (translating exhausted retry attempts to `aborted`), but `WriteBatch.commit()` resolves to `undefined` rather than `WriteResult[]`, write `Precondition` options are not modeled, and `Transaction.getAll()` is absent.',
    status: 'diverged-documented',
    statusNote:
      'WriteBatch.commit() resolves to undefined instead of WriteResult[], write Precondition options are not modeled, and Transaction.getAll() is absent',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/firestore/transaction-query-isolation.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore.test.ts',
      'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
    ],
    evidence:
      'Pinned across local and remote arms in `transaction-query-isolation.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
    risk: ['stateful', 'error-code'],
    riskScore: 3,
    riskReasons: ['asserts atomic batch/transaction execution and WriteResult[]/getAll divergences'],
  }),
  adminRow({
    rowRef: '9',
    featureKeys: [
      'AggregateField',
      'Filter',
      'GeoPoint',
      'GrpcStatus',
      'initializeFirestore',
      'setLogFunction',
      'Firestore.getAll',
      'Firestore.listCollections',
      'Firestore.recursiveDelete',
      'Firestore.bulkWriter',
    ],
    api: 'AggregateField / Filter / GeoPoint / GrpcStatus / initializeFirestore / setLogFunction and Firestore.getAll / listCollections / recursiveDelete / terminate / bulkWriter / bundle / settings',
    behavior:
      'Deferred `firebase-admin/firestore` top-level exports and administrative `Firestore` methods throw `PyricDeferredApiError` naming the unmodeled API instead of failing as `undefined` or silently no-oping.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Deferred firebase-admin/firestore exports and bulk/admin maintenance methods are not yet implemented and throw PyricDeferredApiError explicitly.',
    conformanceTests: ['packages/pyric-admin/test/deferred/subpath-exports.test.ts'],
    evidence: 'Pinned in `packages/pyric-admin/test/deferred/subpath-exports.test.ts`.',
  }),
  adminRow({
    rowRef: '10',
    featureKeys: [
      'FieldValue.vector',
      'Query.select',
      'Query.offset',
      'Query.count',
      'Query.stream',
      'Query.findNearest',
      'Query.explain',
      'Query.explainStream',
      'Query.withConverter',
      'CollectionReference.listDocuments',
      'DocumentReference.listCollections',
      'Transaction.getAll',
    ],
    api: 'FieldValue.vector and unstubbed Query / CollectionReference / DocumentReference / Transaction methods (select, offset, count, stream, findNearest, explain, explainStream, withConverter, listDocuments, listCollections, Transaction.getAll)',
    behavior:
      'Vector sentinels (`FieldValue.vector`), query projections/offsets/streams/vector-search/explain/converters (`Query.{select, offset, count, stream, findNearest, explain, explainStream, withConverter}`), reference discovery (`CollectionReference.listDocuments`, `DocumentReference.listCollections`), and `Transaction.getAll` are not implemented or stubbed on sandbox handles and read as `undefined` at runtime.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Vector embeddings, query projections/offsets/streams/explain/converters, reference listing, and Transaction.getAll are not modeled in pyric-admin/firestore and are allowlisted as absent.',
    conformanceTests: ['packages/pyric-admin/test/surface/admin-surface.test.ts'],
    evidence:
      'Allowlisted and audited against `firebase-admin/firestore` in `packages/pyric-admin/test/surface/admin-surface.test.ts`.',
  }),
  adminRow({
    rowRef: '11',
    featureKeys: [
      'DocumentSnapshot.createTime',
      'DocumentSnapshot.updateTime',
      'DocumentSnapshot.readTime',
      'DocumentSnapshot.isEqual',
      'QuerySnapshot.readTime',
      'QuerySnapshot.isEqual',
      'QuerySnapshot.query',
      'FirebaseFirestoreError',
      'WriteResult',
    ],
    api: 'Snapshot timestamps/equality (createTime, updateTime, readTime, isEqual, QuerySnapshot.query), reference back-pointers (firestore, parent, isEqual), and runtime class/v1 exports',
    behavior:
      '`DocumentSnapshot` and `QuerySnapshot` omit server commit/read timestamps (`createTime`, `updateTime`, `readTime`), `isEqual()`, and `QuerySnapshot.query`; `CollectionReference`/`DocumentReference`/`Query` omit `.firestore` and `.isEqual()` (plus `CollectionReference.parent`); and `pyric-admin/firestore` omits nominal runtime class constructors (`Firestore`, `WriteResult`, `FirebaseFirestoreError`, etc.) and raw gRPC `v1` clients.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Snapshot commit/read timestamps, handle/snapshot equality methods, nominal class constructors, and v1 gRPC clients are not modeled in pyric-admin/firestore and are allowlisted as absent.',
    conformanceTests: ['packages/pyric-admin/test/surface/admin-surface.test.ts'],
    evidence:
      'Allowlisted and audited against `firebase-admin/firestore` in `packages/pyric-admin/test/surface/admin-surface.test.ts`.',
  }),
];

export const firestoreAdminBlock: CompatibilityTableBlock = {
  kind: 'table',
  prefix:
    '## `pyric-admin/firestore`: Admin Firestore chainable CRUD, queries, batches, and transactions\n\nThe admin Firestore plane (surface `firestore-admin`), mirroring `firebase-admin/firestore` across in-process and remote worker sandboxes.\n',
  rows: firestoreAdminRows,
};
