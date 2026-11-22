import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentSnapshot.metadata',
  behavior: 'SnapshotMetadata describing cache origin and pending write status.',
  featureKeys: ['snapshotMetadata'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-crud-merge-sentinels-and-codecs',
    'firestore-swift-batches-transactions-offline-and-errors',
  ],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
