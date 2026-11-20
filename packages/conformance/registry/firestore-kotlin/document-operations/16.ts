import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentReference.set(data, SetOptions.merge())',
  behavior: 'Merges payload fields into existing document without overwriting unspecified fields.',
  featureKeys: ['set', 'merge'],
  status: 'conforms',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
