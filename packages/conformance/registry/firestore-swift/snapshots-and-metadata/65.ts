import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentSnapshot.documentID',
  behavior: 'Unique key string identifying the snapshot document.',
  featureKeys: ['snapshotDocumentID'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
