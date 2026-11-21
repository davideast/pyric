import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.orderByKey()',
  behavior: 'Orders query results lexicographically by child key name.',
  featureKeys: ['orderByKey'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-queries-ranges-limits-and-permission-denied'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
