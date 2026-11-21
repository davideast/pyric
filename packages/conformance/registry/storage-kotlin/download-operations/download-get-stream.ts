import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageReference.getStream(processor?)",
  behavior: "Streams downloaded object bytes through StreamDownloadTask via either a StreamProcessor callback or TaskSnapshot.stream.",
  featureKeys: ["getStream", "StreamDownloadTask"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageDownloadAndFlowTasksTest.kt` (streamDownloadTaskSupportsProcessorAndDirectStreamAndRejectsPauseResume) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt` (livePutStreamZeroAvailableAndStreamDownloadTaskProcessorAndDirectStream).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageDownloadAndFlowTasksTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
