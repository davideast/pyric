import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "storage.reference(forURL:) / storage.reference(for:)",
  behavior: "Parses gs://, Firebase REST, Google Cloud Storage, and Pyric HTTP byte-route download URLs into StorageReference handles and throws StorageErrorCode.bucketMismatch on cross-bucket URLs.",
  featureKeys: ["bucketMismatch", "customGsBucketUrlVariantsAndMismatchErrors"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift` (customGsBucketUrlVariantsAndMismatchErrors), `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
