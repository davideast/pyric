import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentSnapshot.data(as:decoder:)',
  behavior: 'Decodes document snapshot fields directly into Decodable model.',
  featureKeys: ['dataAsDecodable'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
