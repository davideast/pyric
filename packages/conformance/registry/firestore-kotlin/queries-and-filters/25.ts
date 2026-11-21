import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Query.whereArrayContainsAny(field, values)',
  behavior: 'Filters documents where array field contains any element from the values list.',
  featureKeys: ['whereArrayContainsAny'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-queries-cursors-listeners-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
