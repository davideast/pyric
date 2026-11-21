import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 100,
  api: 'FirebaseFirestore.enableNetwork() / disableNetwork()',
  behavior: 'Toggles client network connectivity to simulate offline operation.',
  featureKeys: ['enableNetwork', 'disableNetwork'],
  status: 'conforms',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreLifecycleAndDocsLiveHostConformanceTest.kt',
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
