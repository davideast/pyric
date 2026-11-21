import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 120,
  api: 'FirebaseFirestore.waitForPendingWrites()',
  behavior: 'Resolves when all locally initiated writes have been committed by the server.',
  featureKeys: ['waitForPendingWrites'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-batches-transactions-offline-and-errors'],
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
