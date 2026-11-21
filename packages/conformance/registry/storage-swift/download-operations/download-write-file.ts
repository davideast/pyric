import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageReference.write(toFile:) / writeAsync(toFile:onProgress:)",
  behavior: "Streams object bytes across ranged HTTP chunks to a local file URL with Progress snapshots, 0-byte file support, and partial-file cleanup on cancellation.",
  featureKeys: ["writeAsync", "downloadTaskWriteProgressMaxSizeAndCancelCleanup"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift` (downloadTaskWriteProgressMaxSizeAndCancelCleanup) and `packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift` (multiChunkPutFileAndWriteAsyncOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
