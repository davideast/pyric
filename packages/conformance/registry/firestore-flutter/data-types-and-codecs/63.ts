import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Nested Map and List collections',
  behavior: 'Deeply encodes and revives recursive nested Maps and Lists containing mixed primitives and sentinels.',
  featureKeys: ['data'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
