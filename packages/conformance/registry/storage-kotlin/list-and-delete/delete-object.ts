import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageReference.delete()",
  behavior: "Removes the target object from its bucket so subsequent metadata and download calls fail with StorageException.ERROR_OBJECT_NOT_FOUND while leaving other buckets intact.",
  featureKeys: ["delete"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt` (listAllPaginatedListAndDeleteAcrossHierarchy, customGsBucketIsolatesObjectsAndEnforcesBucketScopedRules).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
