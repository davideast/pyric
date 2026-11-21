import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseStorage.getInstance(app) / Firebase.storage(app)",
  behavior: "Returns a cached FirebaseStorage instance isolated to a named FirebaseApp and recreates cleanly when a same-named app is reinitialized.",
  featureKeys: ["getInstance", "reinitializingSameNamedFirebaseAppProducesFreshStorageInstance"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt` (reinitializingSameNamedFirebaseAppProducesFreshStorageInstance) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
