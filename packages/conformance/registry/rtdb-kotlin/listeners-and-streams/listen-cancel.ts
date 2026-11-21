import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Query.removeEventListener / Job.cancel()',
  behavior: 'Cancels the active listener or coroutine Flow collection and unsubscribes the worker listener.',
  featureKeys: ['removeEventListener'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-listeners-transactions-connection-and-ondisconnect'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
