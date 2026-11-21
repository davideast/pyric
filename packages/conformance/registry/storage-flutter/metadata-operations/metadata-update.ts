import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "ReferencePlatform.updateMetadata(metadata)",
  behavior: "Patches SettableMetadata headers and customMetadata (emitting null tombstones for removed custom keys), enforces caller Storage write rules, and increments metageneration.",
  featureKeys: ["updateMetadata", "SettableMetadata"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_reference_platform_test.dart`, `packages/flutter-client/test/storage/storage_string_and_pagination_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#3, storage-live#7).",
  tests: [
    "packages/flutter-client/test/storage/pyric_reference_platform_test.dart",
    "packages/flutter-client/test/storage/storage_string_and_pagination_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
