import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseStorage.getInstance() / Firebase.storage",
  behavior: "Returns the cached default FirebaseStorage instance bound to the default FirebaseApp and its configured storage bucket.",
  featureKeys: ["getInstance", "storage"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt` (singletonAndCustomBucketFactoriesNormalizeAndCachePerAppAndBucket) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
