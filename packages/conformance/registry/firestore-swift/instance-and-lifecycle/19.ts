import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_LIFECYCLE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 190,
  api: 'Firestore.addSnapshotsInSyncListener(_:)',
  behavior: 'Attaches a callback invoked when all active snapshot listeners synchronize.',
  featureKeys: ['addSnapshotsInSyncListener'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_LIFECYCLE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
