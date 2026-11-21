import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseAppCheck token propagation",
  behavior: "Attaches minted App Check JWTs from the shared FirebaseApp onto Storage WebSocket worker ops and HTTP byte-route X-Firebase-AppCheck headers.",
  featureKeys: ["appCheckToken", "liveSharedFirebaseAppAttachesAppCheckTokensToStorageWsOpsAndHttpByteRoute"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StoragePathBinaryAndAppCheckParityTest.kt` (httpByteRouteAttachesAppCheckAndSessionTokenHeadersOnUploadProbeAndDownload) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt` (liveSharedFirebaseAppAttachesAppCheckTokensToStorageWsOpsAndHttpByteRoute).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StoragePathBinaryAndAppCheckParityTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
