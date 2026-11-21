import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 130,
  api: 'FirebaseFirestorePlatform.snapshotsInSync()',
  behavior: 'Emits an event when all active listeners have caught up to the same state.',
  featureKeys: ['snapshotsInSync'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_lifecycle_and_docs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
