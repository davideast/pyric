import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageTask listeners & activeUploadTasks / activeDownloadTasks",
  behavior: "Delivers progress, paused, success, failure, canceled, and complete callbacks (including executor-scoped and late-listener replay) and tracks in-flight tasks on StorageReference.",
  featureKeys: ["addOnProgressListener", "activeUploadTasks", "activeDownloadTasks"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageTaskAndTransferEdgeTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageTaskMetadataPaginationAndBucketTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageConcurrencyLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageTaskAndTransferEdgeTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageTaskMetadataPaginationAndBucketTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageConcurrencyLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
