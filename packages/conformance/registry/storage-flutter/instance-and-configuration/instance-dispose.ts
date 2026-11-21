import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "PyricFirebaseStoragePlatform.dispose() / clearInstancesForTest()",
  behavior: "Cancels active PyricTaskPlatform transfers, disposes scoped bucket delegates, and rejects post-dispose operations with FirebaseException(code: \"canceled\").",
  featureKeys: ["dispose", "clearInstancesForTest"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#6).",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
