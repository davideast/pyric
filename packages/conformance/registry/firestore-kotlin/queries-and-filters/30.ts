import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 100,
  api: 'Query.limit(limit)',
  behavior: 'Limits maximum number of matched documents returned.',
  featureKeys: ['limit'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-queries-cursors-listeners-and-aggregations'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
