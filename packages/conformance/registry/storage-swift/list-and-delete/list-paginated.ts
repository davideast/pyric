import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.list(maxResults:pageToken:)",
  behavior: "Paginates prefixes and items (1...1000) via cursor pageToken across mid-walk deletions and rejects out-of-range maxResults or malformed pageTokens.",
  featureKeys: ["cursorPaginationHandlesMixedEntriesAndMidWalkMutations", "zeroByteFilesAndCursorPaginationOverHostedRuntime"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift` (cursorPaginationHandlesMixedEntriesAndMidWalkMutations, listPaginationValidatesArguments), `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift` (zeroByteFilesAndCursorPaginationOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
