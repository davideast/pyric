import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DataSnapshot.children',
  behavior: 'Returns an iterable of child DataSnapshots ordered according to the active query.',
  featureKeys: ['children'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-dedicated-crud-and-query-order'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
