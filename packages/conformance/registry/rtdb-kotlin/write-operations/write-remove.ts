import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseReference.removeValue()',
  behavior: 'Removes the node and all descendant data at the reference path.',
  featureKeys: ['removeValue'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-dedicated-crud-and-query-order'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
