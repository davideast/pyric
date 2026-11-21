import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 180,
  api: 'Query.start(atDocument:) / start(afterDocument:)',
  behavior: 'Positions starting cursor using DocumentSnapshot position.',
  featureKeys: ['startAtDocument', 'startAfterDocument'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-queries-cursors-filters-and-aggregations',
    'firestore-swift-inequality-cursors-collectionGroup-and-txRetry',
  ],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
