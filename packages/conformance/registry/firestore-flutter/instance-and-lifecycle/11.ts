import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 110,
  api: 'FirebaseFirestorePlatform.terminate()',
  behavior: 'Terminates the platform client, unsubscribing all active snapshot streams.',
  featureKeys: ['terminate'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
