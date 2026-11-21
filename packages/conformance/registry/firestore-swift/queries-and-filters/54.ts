import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 140,
  api: 'Query.limit(to:)',
  behavior: 'Limits maximum number of matching documents from start of query results.',
  featureKeys: ['limitTo'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-queries-cursors-filters-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
