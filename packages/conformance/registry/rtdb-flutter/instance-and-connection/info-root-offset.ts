import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'ref(\'.info\') / ref(\'.info/serverTimeOffset\')',
  behavior: 'Served by the client: `.info` is `{ connected, serverTimeOffset: 0 }`, `.info/serverTimeOffset` is 0, and any other path under `.info` is null.',
  featureKeys: ['infoRoot', 'serverTimeOffset'],
  status: 'diverged-documented',
  statusNote: 'the offset is always 0: the bridge handshake carries no server timestamp, and production delivers no offset until its first handshake',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
