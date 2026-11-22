import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getFirestore'],
  api: 'getFirestore(app, databaseId)',
  behavior:
    'In the sandbox, `getFirestore(app, databaseId)`, `getFirestore(databaseId)`, and `initializeFirestore(app, settings, databaseId)` return one handle per app and database id, isolating documents and security rules per declared database while answering C3 missing-database behavior on undeclared ids.',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    'Production captures `firestore-named-database-absent` and `firestore-named-database-rules-and-isolation` replayed in `packages/pyric/test/firestore/named-database.test.ts` and `packages/pyric/test/firestore/named-databases-foundation.test.ts`.',
  conformanceTests: [
    'packages/pyric/test/firestore/named-database.test.ts',
    'packages/pyric/test/firestore/named-databases-foundation.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
  ],
  oracleObservations: ['firestore-named-database-absent'],
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts per-database store and rules isolation plus C3 missing-database semantics'],
});
