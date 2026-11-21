import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "PyricFirebaseStoragePlatform.ref([path])",
  behavior: "Creates root and slash-normalized PyricReferencePlatform handles (delegating full URLs to refFromURL) while preserving Unicode, spaces, and percent-reserved characters.",
  featureKeys: ["ref"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart`, `packages/flutter-client/test/storage/storage_concurrency_and_paths_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#8).",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
    "packages/flutter-client/test/storage/storage_concurrency_and_paths_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
