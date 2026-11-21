import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "resolvedBucket / usesNamedBucket / custom gs:// bucket delegates",
  behavior: "Normalizes gs:// and bare bucket specs, resolves default app.options.storageBucket, and isolates objects and Security Rules across custom buckets and secondary FirebaseApp delegates.",
  featureKeys: ["resolvedBucket", "usesNamedBucket"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart`, `packages/flutter-client/test/storage/storage_concurrency_and_paths_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#6, storage-live#9).",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
    "packages/flutter-client/test/storage/storage_concurrency_and_paths_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
