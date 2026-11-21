import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseStorage.getInstance(app, url) / Firebase.storage(app, url)",
  behavior: "Resolves a bucket-isolated FirebaseStorage instance for a gs://<bucket> URL and rejects non-gs:// schemes or object paths.",
  featureKeys: ["parseGsBucketInstanceUrl", "customGsBucketIsolatesObjectsAndEnforcesBucketScopedRules"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt` (getInstanceValidatesGsSchemeAndRejectsObjectPaths) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt` (customGsBucketIsolatesObjectsAndEnforcesBucketScopedRules).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
