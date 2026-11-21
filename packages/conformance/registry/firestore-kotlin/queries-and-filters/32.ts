import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_QUERIES_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 120,
  api: 'Query.startAt(values) / startAfter(values)',
  behavior: 'Positions starting cursor boundary using field values.',
  featureKeys: ['startAt', 'startAfter'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry'],
  tests: [LIVE_HOST_QUERIES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
