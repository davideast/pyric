import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 110,
  api: 'DocumentReference.addSnapshotListener(_:)',
  behavior: 'Attaches real-time closure listener receiving DocumentSnapshot updates.',
  featureKeys: ['addSnapshotListener'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
