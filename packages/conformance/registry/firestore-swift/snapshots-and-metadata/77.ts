import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 140,
  api: 'QuerySnapshot.isEmpty / count',
  behavior: 'Inspection properties reporting empty status and count of matched documents.',
  featureKeys: ['isEmpty', 'count'],
  status: 'conforms',
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
