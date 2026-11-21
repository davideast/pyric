import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DataSnapshot.value / getValue()',
  behavior: 'Returns the deserialized Kotlin value (Map, List, String, Number, Boolean, or null) of the snapshot.',
  featureKeys: ['snapshotValue'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-dedicated-crud-and-query-order'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
