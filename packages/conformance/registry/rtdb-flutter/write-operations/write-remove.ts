import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseReference.remove()',
  behavior: 'Removes the node and all descendant data at the reference path.',
  featureKeys: ['remove'],
  status: 'conforms',
  tests: [
    'packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
