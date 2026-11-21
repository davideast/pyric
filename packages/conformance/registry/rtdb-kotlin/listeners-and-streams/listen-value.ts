import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.snapshots / addValueEventListener',
  behavior: 'Emits DataSnapshot initially and upon any data change at the path via Kotlin Flow or listener.',
  featureKeys: ['snapshots', 'addValueEventListener'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-listeners-transactions-connection-and-ondisconnect'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
