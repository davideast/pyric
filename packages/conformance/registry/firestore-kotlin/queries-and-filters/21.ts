import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.whereEqualTo(field, value)',
  behavior: 'Filters documents matching exact field equality.',
  featureKeys: ['whereEqualTo'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-queries-cursors-listeners-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
