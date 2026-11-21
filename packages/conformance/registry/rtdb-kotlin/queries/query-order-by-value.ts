import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.orderByValue()',
  behavior: 'Orders query results by direct scalar node values.',
  featureKeys: ['orderByValue'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-queries-ranges-limits-and-permission-denied'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
