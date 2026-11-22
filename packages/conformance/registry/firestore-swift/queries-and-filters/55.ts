import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 150,
  api: 'Query.limit(toLast:)',
  behavior: 'Limits results to last N documents requiring explicit orderBy constraint.',
  featureKeys: ['limitToLast'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-queries-cursors-filters-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
