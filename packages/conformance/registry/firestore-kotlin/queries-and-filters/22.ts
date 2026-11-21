import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.whereNotEqualTo(field, value)',
  behavior: 'Filters documents where field does not equal specified value.',
  featureKeys: ['whereNotEqualTo'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
