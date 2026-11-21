import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'WriteBatchPlatform.set(path, data, options)',
  behavior: 'Enqueues set or merge operation into atomic mutation batch.',
  featureKeys: ['set', 'batch'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
