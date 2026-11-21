import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "PyricFirebaseStoragePlatform.registerWith() / delegateFor(app:, bucket:)",
  behavior: "Registers PyricFirebaseStoragePlatform as FirebaseStoragePlatform.instance and caches delegates per (FirebaseApp, normalizedBucket).",
  featureKeys: ["registerWith", "delegateFor"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#1, storage-live#9).",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
