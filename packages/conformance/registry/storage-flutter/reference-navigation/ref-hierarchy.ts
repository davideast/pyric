import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "ReferencePlatform.child(path) / parent / root / fullPath / name / bucket",
  behavior: "Navigates object hierarchies with null parent at root, gs://<bucket>/<fullPath> toString(), and validation rejecting URLs passed to child().",
  featureKeys: ["fullPath", "child", "parent"],
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
