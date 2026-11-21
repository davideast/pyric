import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.onChildAdded',
  behavior: 'Emits DatabaseEvent for each existing child and whenever a new child is added.',
  featureKeys: ['onChildAdded'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_streams_queries_tx_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
