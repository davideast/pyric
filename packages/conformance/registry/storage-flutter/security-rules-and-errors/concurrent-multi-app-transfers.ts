import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Concurrent multi-app & multi-bucket transfers",
  behavior: "Executes parallel multi-chunk uploads, downloads, and deletions across independent FirebaseApp and custom bucket delegates without cross-talk.",
  featureKeys: ["secondaryStorage", "concurrent"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_concurrency_and_paths_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#9).",
  tests: [
    "packages/flutter-client/test/storage/storage_concurrency_and_paths_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
