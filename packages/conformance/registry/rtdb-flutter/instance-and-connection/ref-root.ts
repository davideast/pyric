import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'PyricDatabase.ref()',
  behavior: 'Returns a DatabaseReference pointing to the root of the Realtime Database.',
  featureKeys: ['ref'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
