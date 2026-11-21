import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'QueryPlatform.where(field, isNotEqualTo: value)',
  behavior: 'Filters documents where field does not equal specified value.',
  featureKeys: ['where'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
