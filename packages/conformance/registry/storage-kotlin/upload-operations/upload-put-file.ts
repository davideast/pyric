import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageReference.putFile(uri, metadata?)",
  behavior: "Uploads local file URIs in 256 KiB chunks with MIME inference, progress snapshots, and uploadSessionUri tracking.",
  featureKeys: ["putFile"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt` (putFileUploadsLocalFileInfersMimeHandlesMissingFileAndResumesExistingSession) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt` (liveMultiChunkPutFileAndFileDownloadTaskRoundTripWithProgress).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
