import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.list(maxResults, pageToken?)",
  behavior: "Paginates combined prefixes and items (1..1000) via cursor pageToken without duplicates or gaps and rejects out-of-range maxResults or invalid tokens.",
  featureKeys: ["list", "pageToken"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageTaskMetadataPaginationAndBucketTest.kt` (paginatedListOrdersPrefixesAndItemsInUtf8LexicographicOrderAndValidatesArguments), `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageTaskMetadataPaginationAndBucketTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
