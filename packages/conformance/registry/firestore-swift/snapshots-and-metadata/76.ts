import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 130,
  api: 'QuerySnapshot.documentChanges(includeMetadataChanges:)',
  behavior: 'List of DocumentChange deltas including metadata-only changes.',
  featureKeys: ['documentChangesIncludeMetadata'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
