import { row } from './section.ts';

export default row({
  order: 30,
  api: 'OnDisconnect.set(value) / remove()',
  behavior: 'Registers server-side write or removal operations to execute upon client disconnect.',
  featureKeys: ['onDisconnectSetRemove'],
  evidence: 'Verified by packages/flutter-client/test/rtdb_conformance_test.dart. The Node host runs the operations when the client socket closes, by a close frame or after the host closes a socket that pinged and went silent, and keeps the session signed in for re-attach (ADR-0019): `packages/cli/test/serve/fixtures/hosted-sqlite-relay-ondisconnect.ts`. The app scenario `test/apps/host-closes-silent-consumer` sends the same `rtdb.onDisconnectSet` from a paused `node --import @pyric/cli/register` process on a real dev server, and the host runs it once the liveness window passes.',
});
