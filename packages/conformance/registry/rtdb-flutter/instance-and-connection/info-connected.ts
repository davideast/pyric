import { row } from './section.ts';

export default row({
  order: 60,
  api: 'ref(\'.info/connected\').onValue',
  behavior: 'Served by the client from its bridge connection. It reports false until the client attaches and false whenever the connection is interrupted, closed or taken offline with goOffline(), and true once the client re-attaches. An onDisconnect registered when it turns true reaches the host on the new connection, after the restore.',
  featureKeys: ['infoConnected'],
  extraTests: ['packages/flutter-client/test/rtdb_info_connected_reconnect_test.dart'],
  evidence: 'Verified by packages/flutter-client/test/rtdb_conformance_test.dart, which follows goOffline() and goOnline(), and packages/flutter-client/test/rtdb_info_connected_reconnect_test.dart, which drives a drop, a re-attach and a replaced host over a fake bridge and asserts that no `.info` frame reaches the host.',
});
