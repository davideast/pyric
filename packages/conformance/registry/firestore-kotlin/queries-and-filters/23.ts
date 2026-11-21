import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.whereLessThan / whereLessThanOrEqualTo / whereGreaterThan / whereGreaterThanOrEqualTo',
  behavior: 'Applies relational range comparison filters on field value.',
  featureKeys: ['whereLessThan', 'whereGreaterThan'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
