import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Query.equalTo(value, key)',
  behavior: 'Filters query results to nodes matching the exact sort value and optional key.',
  featureKeys: ['equalTo'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-queries-ranges-limits-and-permission-denied'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
