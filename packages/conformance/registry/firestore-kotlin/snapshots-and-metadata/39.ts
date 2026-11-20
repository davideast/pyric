import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_SNAPSHOTS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentSnapshot.exists()',
  behavior: 'Reports true if document is present in Firestore; false if absent.',
  featureKeys: ['exists'],
  status: 'conforms',
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
