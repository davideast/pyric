import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageException error codes & HTTP status mapping",
  behavior: "Maps wire storage/* codes and HTTP byte-route statuses (401/403/404/412/429) to upstream StorageException.ERROR_* constants (ERROR_OBJECT_NOT_FOUND, ERROR_NOT_AUTHORIZED, ERROR_NOT_AUTHENTICATED, ERROR_QUOTA_EXCEEDED, ERROR_CANCELED, ERROR_INVALID_CHECKSUM, ERROR_RETRY_LIMIT_EXCEEDED).",
  featureKeys: ["StorageException", "ERROR_OBJECT_NOT_FOUND"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageMetadataAndExceptionTest.kt` (storageExceptionConstantsAndWireMappingsMatchUpstreamAndroidSdk), `packages/kt-client/src/test/kotlin/dev/pyric/storage/StoragePathBinaryAndAppCheckParityTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageMetadataAndExceptionTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StoragePathBinaryAndAppCheckParityTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
