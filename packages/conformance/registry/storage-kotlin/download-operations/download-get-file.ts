import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.getFile(destinationUri | destinationFile)",
  behavior: "Streams object bytes across ranged HTTP or WebSocket chunks into a local destination file via FileDownloadTask with progress callbacks and 412 generation-consistency guards.",
  featureKeys: ["getFile", "FileDownloadTask"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageDownloadAndFlowTasksTest.kt` (fileDownloadTaskStreamsMultiChunkDataSupportsUriAndFileOverloadsAndHandlesErrors), `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageConcurrencyAndCancelParityTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageDownloadAndFlowTasksTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageConcurrencyAndCancelParityTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
