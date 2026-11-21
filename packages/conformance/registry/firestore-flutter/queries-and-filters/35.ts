import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 150,
  api: 'QueryPlatform.get(options)',
  behavior: 'Executes query and returns QuerySnapshotPlatform containing matched documents.',
  featureKeys: ['get'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
