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
});
