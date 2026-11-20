import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'ServerValue.timestamp',
  behavior: 'Resolves server-side timestamp sentinel into current epoch milliseconds upon write.',
  featureKeys: ['serverTimestamp'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
