import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'CollectionReferencePlatform.doc([path])',
  behavior: 'Returns DocumentReferencePlatform under collection; auto-generates 20-char ID if path omitted.',
  featureKeys: ['doc'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
