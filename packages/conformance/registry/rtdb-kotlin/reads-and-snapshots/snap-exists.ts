import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DataSnapshot.exists()',
  behavior: 'Returns true if the DataSnapshot contains non-null data.',
  featureKeys: ['exists'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-dedicated-crud-and-query-order'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
