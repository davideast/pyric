import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 100,
  api: 'Query.whereField(_:notIn:)',
  behavior: 'Filters documents where field value matches none in argument list.',
  featureKeys: ['whereFieldNotIn'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
