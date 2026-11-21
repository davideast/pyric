import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 130,
  api: 'QueryPlatform.endAt(values) / endBefore(values)',
  behavior: 'Positions ending cursor boundary using field values.',
  featureKeys: ['endAt', 'endBefore'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
