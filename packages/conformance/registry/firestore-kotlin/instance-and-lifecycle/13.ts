import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 130,
  api: 'FirebaseFirestore.addSnapshotsInSyncListener(runnable)',
  behavior: 'Notifies when all active snapshot listeners are in sync with server state.',
  featureKeys: ['snapshotsInSync'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-instance-flows-inSync-and-toObject'],
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
