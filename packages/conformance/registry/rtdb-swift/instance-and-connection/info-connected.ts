import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

const INFO_RECONNECT_TESTS = 'packages/swift-client/Tests/PyricFirestoreTests/RtdbInfoConnectedTests.swift';

export default row({
  order: 60,
  api: 'reference(withPath: ".info/connected").observe(.value)',
  behavior: 'Served by the client from its bridge connection. It reports false until the client attaches and false whenever the connection is interrupted, closed or taken offline with goOffline(), and true once the client re-attaches. An onDisconnect registered when it turns true reaches the host on the new connection, after the restore.',
  featureKeys: ['infoConnected'],
  status: 'conforms',
  tests: [INFO_RECONNECT_TESTS],
  evidence: 'FirebaseDatabase Swift specification and ADR-0019 (amendment of 2026-10-16). The conformance test asserts the values across attach, goOffline() and goOnline(), and that no `.info` listen or read reaches the worker. Reconnect tests: `RtdbInfoConnectedTests.swift` asserts false, true, false, true across a drop with no repeated value, a presence re-arm sent on the new socket after the replayed listener and the held operation, and after the Auth restore on a replaced host.',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: ['rtdb-swift-listeners-transactions-connection-and-ondisconnect'],
});
