import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'OnDisconnect.setValue(value) / removeValue()',
  behavior: 'Registers server-side write or removal operations to execute upon client disconnect.',
  featureKeys: ['onDisconnectSetRemove'],
  evidence: 'com.google.firebase:firebase-database specification. The Node host runs the operations when the client socket closes, by a close frame or after the host closes a socket that pinged and went silent, and keeps the session signed in for re-attach (ADR-0019): `packages/cli/test/serve/fixtures/hosted-sqlite-relay-ondisconnect.ts`. The app scenario `test/apps/host-closes-silent-consumer` sends the same `rtdb.onDisconnectSet` from a paused `node --import @pyric/cli/register` process on a real dev server, and the host runs it once the liveness window passes.',
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
