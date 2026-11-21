import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentReference.snapshots',
  behavior: 'AsyncSequence streaming real-time DocumentSnapshot updates via Swift concurrency.',
  featureKeys: ['documentSnapshotsSequence'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
