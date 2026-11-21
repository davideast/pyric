import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_QUERIES_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.whereField(_:isLessThan:)',
  behavior: 'Filters documents where field is strictly less than value.',
  featureKeys: ['whereFieldLessThan'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
