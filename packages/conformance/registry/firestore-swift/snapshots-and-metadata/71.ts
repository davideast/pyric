import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 80,
  api: 'DocumentSnapshot.subscript',
  behavior: 'Provides subscript syntax snapshot[key] to access document fields.',
  featureKeys: ['subscript'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
