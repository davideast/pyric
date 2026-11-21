import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.putStream(stream, metadata?)",
  behavior: "Streams arbitrary InputStream sources (including streams reporting available() == 0) across multi-chunk transfers and closes the input stream upon completion.",
  featureKeys: ["putStream"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt` (putStreamReadsWithoutAvailableClosesStreamAndRoundTripsMultiChunkPayload) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt` (livePutStreamZeroAvailableAndStreamDownloadTaskProcessorAndDirectStream).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
