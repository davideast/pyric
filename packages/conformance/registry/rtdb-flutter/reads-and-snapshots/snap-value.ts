import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DataSnapshot.value',
  behavior: 'Returns the deserialized Dart value (Map, List, String, num, bool, or null) of the snapshot.',
  featureKeys: ['snapshotValue'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
