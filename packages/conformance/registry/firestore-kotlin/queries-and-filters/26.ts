import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'Query.whereIn(field, values)',
  behavior: 'Filters documents where field value matches any element in values list (IN query).',
  featureKeys: ['whereIn'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-queries-cursors-listeners-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
