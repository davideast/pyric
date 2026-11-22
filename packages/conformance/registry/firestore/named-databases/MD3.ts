import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['getFirestore'],
  api: 'pyric-admin getFirestore(app, databaseId)',
  behavior:
    '`pyric-admin` `getFirestore(app, databaseId)`, `getFirestore(databaseId)`, and `initializeFirestore(app, settings, databaseId)` select the named database across both the in-process arm and the remote worker arm (requiring `workerProtocol >= 2`), reject undeclared databases at RPC time with gRPC `5 NOT_FOUND`, store cross-database `DocumentReference` fields with their target database id, and reject cross-database batches/transactions with gRPC `3 INVALID_ARGUMENT`.',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    'Production captures `firestore-named-database-admin-mixing` and `firestore-named-database-absent` (firebase-admin 13.10.0) replayed across both in-process and remote SharedWorker arms in `packages/pyric-admin/test/firestore/named-database.test.ts` and `packages/pyric-admin/test/firestore/admin-named-databases.test.ts`.',
  conformanceTests: [
    'packages/pyric-admin/test/firestore/named-database.test.ts',
    'packages/pyric-admin/test/firestore/admin-named-databases.test.ts',
  ],
  oracleObservations: ['firestore-named-database-admin-mixing'],
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts per-database isolation, C3 NOT_FOUND, and C4 cross-database batch/reference semantics across local and remote arms'],
});
