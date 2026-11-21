import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'QueryPlatform.where(field, arrayContainsAny: values)',
  behavior: 'Filters documents where array field contains any element from the values list.',
  featureKeys: ['where', 'arrayContainsAny'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
