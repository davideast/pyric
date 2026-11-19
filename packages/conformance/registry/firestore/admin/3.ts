import { row } from './section.ts';

export default row({
  order: 40,
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
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-paths-and-autoids'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/firestore/sandbox-ops.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-paths-and-autoids` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `sandbox-ops.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts path parity and auto-ID format'],
});
