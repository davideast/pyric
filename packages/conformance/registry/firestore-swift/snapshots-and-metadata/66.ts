import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentSnapshot.reference',
  behavior: 'DocumentReference pointing to the snapshot document location.',
  featureKeys: ['reference'],
  status: 'conforms',
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
