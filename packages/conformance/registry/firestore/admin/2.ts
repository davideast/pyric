import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['Firestore.databaseId'],
  api: 'getFirestore(app, databaseId) and Firestore.databaseId',
  behavior:
    'Isolates documents, batches, and transactions per named Firestore database across both in-process and remote SharedWorker arms and exposes readonly `db.databaseId` on `AdminFirestore` handles (`"(default)"` for default handles or the normalized database id for named handles).',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-named-database-admin-mixing'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/named-database.test.ts',
    'packages/pyric-admin/test/surface/admin-surface.test.ts',
    'packages/pyric/test/firestore/oracle-conformance.test.ts',
  ],
  evidence:
    'Production capture `firestore-named-database-admin-mixing` (firebase-admin 13.10.0) replayed across both in-process and remote SharedWorker arms in `packages/pyric-admin/test/firestore/named-database.test.ts`, gated by `packages/pyric/test/firestore/oracle-conformance.test.ts`, and verified against upstream `firebase-admin` types in `packages/pyric-admin/test/surface/admin-surface.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: [
    'asserts readonly Firestore.databaseId, per-database isolation, cross-db reference storage, and gRPC 3 INVALID_ARGUMENT rejection across local and remote arms',
  ],
});
