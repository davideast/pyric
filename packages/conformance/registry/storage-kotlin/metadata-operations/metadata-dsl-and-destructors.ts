import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "storageMetadata { ... } & KTX componentN() destructuring",
  behavior: "Builds StorageMetadata instances via the Kotlin DSL and destructures UploadTask.TaskSnapshot, FileDownloadTask.TaskSnapshot, StreamDownloadTask.TaskSnapshot, and ListResult.",
  featureKeys: ["storageMetadata", "component1"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageMetadataAndExceptionTest.kt` (storageMetadataBuilderAndKtxDslBuildIsolatedImmutableSnapshots), `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageMetadataAndExceptionTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
