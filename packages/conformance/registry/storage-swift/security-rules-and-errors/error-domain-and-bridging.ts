import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageErrorCode / StorageErrorDomain NSError bridging & pattern matching",
  behavior: "Maps wire storage/* codes and HTTP statuses to StorageErrorCode (objectNotFound, unauthorized, unauthenticated, quotaExceeded, cancelled, downloadSizeExceeded, bucketMismatch) with StorageErrorDomain NSError bridging and ~= pattern matching.",
  featureKeys: ["StorageErrorCode", "StorageErrorDomain"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift` (errorCodesAndPatternMatching), `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
