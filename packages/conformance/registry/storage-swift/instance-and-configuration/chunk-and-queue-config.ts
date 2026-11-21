import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "uploadChunkSizeBytes / callbackQueue",
  behavior: "Normalizes uploadChunkSizeBytes to 256 KiB multiples governing resumable upload slice sizes and dispatches completion and observer callbacks onto callbackQueue.",
  featureKeys: ["uploadChunkSizeBytes", "callbackQueue"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageObservableTaskTests.swift` (explicitUploadChunkSizeBytesGovernsPartSizes), `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageObservableTaskTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
