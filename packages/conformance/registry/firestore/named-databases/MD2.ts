import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['getFirestore'],
  api: 'getFirestore(app, databaseId) (served mode)',
  behavior:
    'The served `firebase/firestore` entry binds `getFirestore(app, databaseId)`, `getFirestore(databaseId)`, and `initializeFirestore(app, settings, databaseId)` to the named database across both the SharedWorker protocol v2 path (refusing protocol-1 peers on first named-db op) and the in-page runtime fallback.',
  status: 'conforms',
  automation: 'unit-backed',
  evidence:
    '`packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts`, `packages/cli/test/serve/worker/composite-filters-served-entry.test.ts`, and `packages/cli/test/serve/worker/named-databases-worker.test.ts` verify per-database handle identity, `refEqual` database scoping, per-database isolation, and worker protocol v2 routing over the served `firebase/firestore` entry.',
  conformanceTests: [
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
    'packages/cli/test/serve/worker/composite-filters-served-entry.test.ts',
    'packages/cli/test/serve/worker/named-databases-worker.test.ts',
  ],
  risk: ['error-code', 'stateful'],
  riskScore: 2,
  riskReasons: ['asserts served worker protocol v2 databaseId routing and per-app handle caching'],
});
