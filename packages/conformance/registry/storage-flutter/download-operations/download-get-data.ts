import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "ReferencePlatform.getData(maxSize)",
  behavior: "Downloads object bytes up to maxSize (supporting maxSize == 0 for 0-byte objects and chunked range fallback) and throws FirebaseException(code: \"download-size-exceeded\") when exceeded.",
  featureKeys: ["getData", "download-size-exceeded"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_reference_platform_test.dart`, `packages/flutter-client/test/storage/storage_edge_cases_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#2, storage-live#8).",
  tests: [
    "packages/flutter-client/test/storage/pyric_reference_platform_test.dart",
    "packages/flutter-client/test/storage/storage_edge_cases_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
