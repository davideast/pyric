import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 230,
  api: 'Query.addSnapshotListener(options:listener:)',
  behavior: 'Attaches real-time query listener configured with SnapshotListenOptions.',
  featureKeys: ['addQuerySnapshotListenerOptions'],
  status: 'conforms',
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
