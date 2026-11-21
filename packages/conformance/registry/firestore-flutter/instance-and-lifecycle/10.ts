import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 100,
  api: 'FirebaseFirestorePlatform.enableNetwork() / disableNetwork()',
  behavior: 'Toggles client network connectivity to simulate offline operation.',
  featureKeys: ['enableNetwork', 'disableNetwork'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
