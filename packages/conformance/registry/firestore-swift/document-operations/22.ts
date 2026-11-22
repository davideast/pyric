import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentReference.documentID',
  behavior: 'Returns the document identifier representing the last path component.',
  featureKeys: ['documentID'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
