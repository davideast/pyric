import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 80,
  api: 'Firestore.collection(_:)',
  behavior: 'Instantiates a CollectionReference pointing to the slash-delimited collection path.',
  featureKeys: ['collection'],
  status: 'conforms',
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
