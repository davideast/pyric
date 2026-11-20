import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'PyricDatabase.instanceFor(databaseURL)',
  behavior: 'Returns a distinct Realtime Database handle for each database URL; production isolates the data and rules of each URL\'s database.',
  featureKeys: ['instanceFor'],
  status: 'conforms',
  extraTests: ['packages/flutter-client/test/rtdb_instance_wire_test.dart'],
  tests: [
    'packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  evidence: 'Verified by packages/flutter-client/test/rtdb_conformance_test.dart, packages/flutter-client/test/rtdb_instance_wire_test.dart, and packages/flutter-client/test/live_host/rtdb_live_host_conformance_test.dart across default, shard-00, shard-01, and shard-02 rulesets.',
});
