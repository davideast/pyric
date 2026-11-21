import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'CollectionReferencePlatform.add(data)',
  behavior: 'Generates auto-ID, writes document data, and returns DocumentReferencePlatform.',
  featureKeys: ['add'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
