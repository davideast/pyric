import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Storage Security Rules & PyricAuthCredentialsProvider / AuthLens",
  behavior: "Propagates the active FirebaseAuth session or explicit AuthLens onto Storage operations, denying unauthenticated or cross-user callers with FirebaseException(code: \"unauthorized\").",
  featureKeys: ["authLens", "unauthorized"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#1, storage-live#2, storage-live#6).",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
