import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageReference.putFileAsync(from:metadata:onProgress:)",
  behavior: "Streams local file URL payloads in 256 KiB chunks with MIME inference, Progress updates, 0-byte file support, and missing or directory URL validation.",
  featureKeys: ["putFileAsync"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift` (putFileStreamsMultiChunkWithMimeInferenceAndProgress) and `packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift` (multiChunkPutFileAndWriteAsyncOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
