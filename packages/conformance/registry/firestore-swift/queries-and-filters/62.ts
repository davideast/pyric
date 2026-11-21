import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 220,
  api: 'Query.addSnapshotListener(includeMetadataChanges:listener:)',
  behavior: 'Attaches real-time query listener receiving metadata-only change notifications.',
  featureKeys: ['addQuerySnapshotListenerMetadata'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-queries-cursors-filters-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
