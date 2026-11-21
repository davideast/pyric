import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageReference.delete()",
  behavior: "Deletes the object at the reference across async and completion overloads so subsequent reads or deletes fail with StorageErrorCode.objectNotFound without affecting sibling buckets.",
  featureKeys: ["delete"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift`, `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
