import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'QuerySnapshotPlatform.docChanges',
  behavior: 'Exposes List<DocumentChangePlatform> detailing added, modified, removed types and index shifts.',
  featureKeys: ['docChanges'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
