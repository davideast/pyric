import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DataSnapshot.key',
  behavior: 'Returns the key name of the location that generated the DataSnapshot.',
  featureKeys: ['snapshotKey'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-dedicated-crud-and-query-order'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
