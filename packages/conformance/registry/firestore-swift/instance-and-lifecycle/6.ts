import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 60,
  api: 'Firestore.app',
  behavior: 'Returns the FirebaseApp associated with this Firestore instance.',
  featureKeys: ['app'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
