import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "StorageTask.pause() / resume() / cancel()",
  behavior: "Pauses, resumes, and cancels in-flight UploadTask and FileDownloadTask transfers, aborting or rolling back uncommitted server uploads and propagating ERROR_CANCELED across GMS Task, coroutines await(), and Tasks.await.",
  featureKeys: ["pause", "resume", "cancel"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageConcurrencyAndCancelParityTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageConcurrencyLiveHostConformanceTest.kt` (liveCanceledMultiChunkUploadPreservesExistingObjectAndPropagatesErrorCanceled).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageConcurrencyAndCancelParityTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageConcurrencyLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
