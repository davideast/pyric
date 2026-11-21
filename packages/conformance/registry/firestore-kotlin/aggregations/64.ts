import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_TRANSACTIONS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'AggregateQuery.count()',
  behavior: 'Returns count of matched documents without pulling full document payloads.',
  featureKeys: ['count'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-queries-cursors-listeners-and-aggregations'],
  tests: [LIVE_HOST_TRANSACTIONS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
