import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 80,
  api: 'Query.whereField(_:arrayContainsAny:)',
  behavior: 'Filters documents where array field contains any element from argument list.',
  featureKeys: ['whereFieldArrayContainsAny'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
