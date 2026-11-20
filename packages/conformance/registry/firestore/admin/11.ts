import { row } from './section.ts';

export default row({
  order: 120,
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
  api: 'Snapshot timestamps/equality (createTime, updateTime, readTime, isEqual, QuerySnapshot.query), reference back-pointers (firestore, parent, isEqual), WriteResult, and FirebaseFirestoreError',
  behavior:
    'Exposes monotonic `DocumentSnapshot.{createTime, updateTime, readTime, isEqual}` and `QuerySnapshot.{readTime, isEqual, query}` (ignoring read/commit metadata in `isEqual` as upstream does), `CollectionReference`/`DocumentReference`/`Query` `.firestore` and `.isEqual()` plus `CollectionReference.parent`, and runtime `WriteResult` and `FirebaseFirestoreError` classes from `pyric-admin/firestore` across local and remote sandboxes (raw gRPC `v1` clients and unexported nominal base classes remain allowlisted).',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-snapshot-and-reference-metadata'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/admin-reference-and-snapshot-equality.test.ts',
    'packages/pyric-admin/test/firestore/admin-vector-and-errors.test.ts',
    'packages/pyric-admin/test/firestore/admin-doc-ref-wrapper.test.ts',
    'packages/pyric-admin/test/surface/admin-surface.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-snapshot-and-reference-metadata` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus reference/snapshot equality and `admin-surface.test.ts`.',
  risk: ['stateful'],
  riskScore: 3,
  riskReasons: ['asserts snapshot createTime/updateTime/readTime invariants, metadata-ignoring isEqual, reference back-pointers, and WriteResult/FirebaseFirestoreError runtime exports'],
});
