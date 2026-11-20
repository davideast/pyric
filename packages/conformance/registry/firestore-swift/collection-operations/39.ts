import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 50,
  api: 'CollectionReference.document(_:)',
  behavior: 'Instantiates a child DocumentReference at relative document path.',
  featureKeys: ['documentPath'],
  status: 'conforms',
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
