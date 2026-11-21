import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseDatabase.goOffline() / goOnline()',
  behavior: 'Suspends and resumes the Realtime Database connection to the Pyric worker. goOffline() also turns `.info/connected` false until goOnline().',
  featureKeys: ['goOffline', 'goOnline'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-listeners-transactions-connection-and-ondisconnect'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
