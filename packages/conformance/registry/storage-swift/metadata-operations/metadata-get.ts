import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "StorageReference.getMetadata() / metadata()",
  behavior: "Retrieves StorageMetadata (bucket, path, name, size, generation, metageneration, md5Hash, timeCreated, updated, content headers, and customMetadata) via async throws, callback, and Result overloads.",
  featureKeys: ["getMetadata", "StorageMetadata"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift`, `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
