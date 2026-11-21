import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 90,
  api: 'QueryPlatform.orderBy(field, descending: bool)',
  behavior: 'Orders query results by field ascending or descending.',
  featureKeys: ['orderBy'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
