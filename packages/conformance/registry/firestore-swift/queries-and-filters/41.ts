import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.whereField(_:isEqualTo:)',
  behavior: 'Filters documents matching exact field equality.',
  featureKeys: ['whereFieldEqualTo'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-queries-cursors-filters-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
