import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'WriteBatchPlatform.commit()',
  behavior: 'Atomically commits all enqueued mutations across multiple documents.',
  featureKeys: ['commit', 'batch'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
