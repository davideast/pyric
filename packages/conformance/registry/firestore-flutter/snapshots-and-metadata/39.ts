import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentSnapshotPlatform.exists',
  behavior: 'Reports true if document is present in Firestore; false if absent.',
  featureKeys: ['exists'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
