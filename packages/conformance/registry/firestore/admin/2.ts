import { row } from './section.ts';

export default row({
  order: 30,
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
});
