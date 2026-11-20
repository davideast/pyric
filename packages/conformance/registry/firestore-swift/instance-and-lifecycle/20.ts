import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_LIFECYCLE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 200,
  api: 'Firestore.loadBundle(_:)',
  behavior: 'Loads serialized Firestore bundle data into the local cache.',
  featureKeys: ['loadBundle'],
  status: 'conforms',
  tests: [LIVE_HOST_LIFECYCLE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
