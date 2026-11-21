import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "ReferencePlatform.delete()",
  behavior: "Deletes the stored object so subsequent getMetadata, getData, or delete calls fail with FirebaseException(code: \"object-not-found\") without affecting other buckets.",
  featureKeys: ["delete"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_reference_platform_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#6).",
  tests: [
    "packages/flutter-client/test/storage/pyric_reference_platform_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
