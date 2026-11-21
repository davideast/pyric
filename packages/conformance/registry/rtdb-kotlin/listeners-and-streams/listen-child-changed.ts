import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.childEvents / onChildChanged',
  behavior: 'Emits ChildEvent.Changed whenever an existing child node is modified.',
  featureKeys: ['onChildChanged'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-listeners-transactions-connection-and-ondisconnect'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
