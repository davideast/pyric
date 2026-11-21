import { INFO_RECONNECT_TEST, LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'getReference(".info/connected") with a value listener',
  behavior: 'Served by the client from its bridge connection. It reports false until the client attaches and false whenever the connection is interrupted, closed or taken offline with goOffline(), and true once the client re-attaches. An onDisconnect registered when it turns true reaches the host on the new connection, after the restore.',
  featureKeys: ['infoConnected'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-listeners-transactions-connection-and-ondisconnect'],
  evidence: 'com.google.firebase:firebase-database specification; ADR-0019 amendment "every client serves `.info` locally". No `.info` listener or read reaches the host. Reconnect tests: `InfoConnectedReconnectTest.kt` pins false, true, false, true across a drop with no repeated value, and a presence re-arm from the true callback sent on the new socket after the replayed listeners, the held operation and, on a replaced host, the Auth restore.',
  tests: [INFO_RECONNECT_TEST],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
