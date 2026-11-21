import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "ReferencePlatform.listAll()",
  behavior: "Enumerates all immediate child prefixes and items as PyricListResultPlatform with nextPageToken == null.",
  featureKeys: ["listAll"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_reference_platform_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#5).",
  tests: [
    "packages/flutter-client/test/storage/pyric_reference_platform_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
