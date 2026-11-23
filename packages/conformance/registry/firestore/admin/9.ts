import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: [
    'GeoPoint',
    'GrpcStatus',
    'initializeFirestore',
    'setLogFunction',
    'Firestore.getAll',
    'Firestore.listCollections',
    'Firestore.recursiveDelete',
    'Firestore.bulkWriter',
  ],
  api: 'GeoPoint / GrpcStatus / initializeFirestore / setLogFunction and Firestore.getAll / listCollections / recursiveDelete / terminate / bulkWriter / bundle / settings',
  behavior:
    'Models `GeoPoint` (coordinate range validation, getters, `isEqual`, document round-trip), `GrpcStatus` bidirectional codes, `initializeFirestore(app, settings?)` & single-call `db.settings({ ignoreUndefinedProperties })`, `setLogFunction`, `db.getAll(...refsOrReadOptions)` (ordered snapshots + `fieldMask` + 0-arg error), `db.listCollections()`, `db.recursiveDelete(ref, bulkWriter?)`, `db.bulkWriter(options?)` (including `BulkWriterError`, default/custom retries, idempotent `close()`, and synchronous post-close `flush()`), `db.bundle(id)`, and `db.terminate()` across local and remote sandboxes.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-geopoint-init-and-maintenance'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/admin-bulk-writer.test.ts',
    'packages/pyric-admin/test/surface/admin-surface.test.ts',
  ],
  evidence:
    '`observations/firestore-admin/firestore-admin-geopoint-init-and-maintenance.json` replayed across both local and remote JSON-wire arms in `packages/pyric-admin/test/firestore/oracle-conformance.test.ts`.',
});
