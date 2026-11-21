import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.onChildChanged',
  behavior: 'Emits DatabaseEvent whenever an existing child node is modified.',
  featureKeys: ['onChildChanged'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_streams_queries_tx_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
