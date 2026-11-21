import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TRANSACTIONS_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.snapshots',
  behavior: 'AsyncSequence streaming real-time QuerySnapshot updates via Swift concurrency.',
  featureKeys: ['querySnapshotsSequence'],
  status: 'conforms',
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
