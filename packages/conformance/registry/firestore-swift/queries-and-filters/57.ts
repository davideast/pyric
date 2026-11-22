import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 170,
  api: 'Query.end(before:) / end(at:)',
  behavior: 'Positions ending cursor using ordered field values.',
  featureKeys: ['endBefore', 'endAt'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-queries-cursors-filters-and-aggregations',
    'firestore-swift-inequality-cursors-collectionGroup-and-txRetry',
  ],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
