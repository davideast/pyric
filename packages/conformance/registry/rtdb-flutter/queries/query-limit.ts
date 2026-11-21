import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'Query.limitToFirst(limit) / limitToLast(limit)',
  behavior: 'Caps query results to the first N or last N ordered child nodes.',
  featureKeys: ['limitToFirst', 'limitToLast'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_streams_queries_tx_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
