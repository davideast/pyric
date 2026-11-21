import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 160,
  api: 'QueryPlatform.snapshots(options)',
  behavior: 'Returns broadcast stream emitting QuerySnapshotPlatform upon matching changes.',
  featureKeys: ['snapshots'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
