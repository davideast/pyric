import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 70,
  api: 'Query.whereField(_:arrayContains:)',
  behavior: 'Filters documents where array field contains argument element.',
  featureKeys: ['whereFieldArrayContains'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-queries-cursors-filters-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
