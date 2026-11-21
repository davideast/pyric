import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DatabaseReference.update(values)',
  behavior: 'Performs a multi-path atomic update of specified child keys without overwriting omitted siblings.',
  featureKeys: ['update'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
