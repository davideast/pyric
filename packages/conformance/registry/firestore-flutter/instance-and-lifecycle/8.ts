import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  api: 'FirebaseFirestorePlatform.runTransaction(handler, {timeout, maxAttempts})',
  behavior: 'Runs interactive transaction handler with automatic conflict retries.',
  featureKeys: ['runTransaction'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
