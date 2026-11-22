import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentReference.path',
  behavior: 'Returns the slash-delimited path relative to the database root.',
  featureKeys: ['path'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
