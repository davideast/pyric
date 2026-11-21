import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentReference.get(source)',
  behavior: 'Reads a single document snapshot from server or cache based on Source.',
  featureKeys: ['get'],
  status: 'conforms',
  oracleObservations: [
    'firestore-kotlin-crud-merge-sentinels-and-codecs',
    'firestore-kotlin-batches-transactions-offline-and-errors',
  ],
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
