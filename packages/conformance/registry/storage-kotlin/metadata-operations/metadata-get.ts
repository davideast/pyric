import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "StorageReference.getMetadata()",
  behavior: "Retrieves immutable StorageMetadata snapshots carrying bucket, path, name, sizeBytes, generation, metadataGeneration, md5Hash, creationTimeMillis, updatedTimeMillis, content headers, and customMetadataKeys.",
  featureKeys: ["getMetadata"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageMetadataAndExceptionTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageMetadataAndExceptionTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
