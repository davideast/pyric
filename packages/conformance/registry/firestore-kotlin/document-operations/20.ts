import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DocumentReference.snapshots(metadataChanges)',
  behavior: 'Returns a Coroutine Flow emitting DocumentSnapshot on document changes.',
  featureKeys: ['snapshots'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-instance-flows-inSync-and-toObject'],
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
