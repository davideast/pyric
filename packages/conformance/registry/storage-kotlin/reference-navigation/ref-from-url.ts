import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseStorage.getReferenceFromUrl(fullUrl)",
  behavior: "Parses gs://, Firebase REST, Google Cloud Storage, and Pyric HTTP byte-route URLs into StorageReference handles and throws IllegalArgumentException on bucket mismatch.",
  featureKeys: ["getReferenceFromUrl"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt` (getReferenceFromUrlParsesGsFirebaseCloudAndPyricByteRouteUrls), `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
