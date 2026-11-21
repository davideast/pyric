import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentReference.update(data)',
  behavior: 'Updates specified fields in an existing document; fails if document does not exist.',
  featureKeys: ['update'],
  status: 'conforms',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
