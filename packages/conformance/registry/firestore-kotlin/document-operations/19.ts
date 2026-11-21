import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DocumentReference.collection(path)',
  behavior: 'Returns a child CollectionReference nested under this document.',
  featureKeys: ['collection'],
  status: 'conforms',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
