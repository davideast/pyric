import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: "StorageReference root-level preconditions",
  behavior: "Rejects object-only operations (getBytes, getMetadata, updateMetadata, getDownloadUrl, delete, putBytes, getFile, getStream) on the bucket root while permitting listAll() and list().",
  featureKeys: ["rootReferencePreconditionsAuthLensAndCustomBucketWireParams", "liveRootReferenceOperationsAndMismatchedBucketUrlsRejectCleanly"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt` (rootReferencePreconditionsAuthLensAndCustomBucketWireParams) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt` (liveRootReferenceOperationsAndMismatchedBucketUrlsRejectCleanly).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
