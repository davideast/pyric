import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Storage Security Rules & FirebaseAuth integration",
  behavior: "Evaluates deployed per-bucket Storage Security Rules under the active FirebaseAuth user or AuthLens, denying unauthenticated or post-signOut() operations with StorageException.ERROR_NOT_AUTHORIZED.",
  featureKeys: ["ERROR_NOT_AUTHORIZED", "deniesUnauthenticatedOperationsUnderStorageSecurityRules"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt` (deniesUnauthenticatedOperationsUnderStorageSecurityRules, authenticatedUploadDownloadMetadataUpdateAndSignOutRevocation).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
