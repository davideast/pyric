import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "StorageReference.putDataAsync(_:metadata:onProgress:)",
  behavior: "Uploads in-memory Data (including 0-byte and multi-chunk > 256 KiB payloads) with optional StorageMetadata, Progress callbacks, and structured Task cancellation propagation.",
  featureKeys: ["putDataAsync"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift` (multiChunkPutDataAsyncWithCustomUploadChunkSize), `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
