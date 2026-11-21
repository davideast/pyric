import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 60,
  api: 'DocumentSnapshot.data(with:)',
  behavior: 'Returns document fields configuring ServerTimestampBehavior handling.',
  featureKeys: ['dataWithServerTimestampBehavior'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
