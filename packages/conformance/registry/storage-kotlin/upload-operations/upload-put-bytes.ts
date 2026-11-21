import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "StorageReference.putBytes(bytes, metadata?)",
  behavior: "Uploads byte arrays (0-byte through multi-chunk > 256 KiB payloads) with optional StorageMetadata and resolves UploadTask.TaskSnapshot with server metadata and byte counts.",
  featureKeys: ["putBytes"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt` (putBytesAndGetBytesRoundTripBinaryDataMetadataAndProgress), `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
