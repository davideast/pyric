import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'FirebaseFirestore.collectionGroup(collectionId)',
  behavior: 'Instantiates a Query spanning all collections with the specified collectionId.',
  featureKeys: ['collectionGroup'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
