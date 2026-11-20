import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 210,
  api: 'Query.addSnapshotListener(_:)',
  behavior: 'Attaches real-time query listener returning ListenerRegistration handle.',
  featureKeys: ['addQuerySnapshotListener'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
