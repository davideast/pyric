import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFirestorePlatform.settings',
  behavior: 'Configures host, sslEnabled, persistenceEnabled, and cacheSizeBytes.',
  featureKeys: ['settings'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
