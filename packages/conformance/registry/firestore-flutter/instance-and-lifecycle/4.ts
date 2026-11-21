import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseFirestorePlatform.doc(path)',
  behavior: 'Instantiates a DocumentReferencePlatform pointing to the slash-delimited path.',
  featureKeys: ['doc'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
