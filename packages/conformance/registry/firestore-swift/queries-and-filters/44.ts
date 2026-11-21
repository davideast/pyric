import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 40,
  api: 'Query.whereField(_:isLessThanOrEqualTo:)',
  behavior: 'Filters documents where field is less than or equal to value.',
  featureKeys: ['whereFieldLessThanOrEqualTo'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-queries-cursors-filters-and-aggregations',
    'firestore-swift-inequality-cursors-collectionGroup-and-txRetry',
  ],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
