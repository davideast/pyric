import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'QueryPlatform.where(field, isEqualTo: value)',
  behavior: 'Filters documents matching exact field equality.',
  featureKeys: ['where'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
