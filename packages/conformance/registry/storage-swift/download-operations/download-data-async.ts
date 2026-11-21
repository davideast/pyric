import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "StorageReference.data(maxSize:) async throws -> Data",
  behavior: "Downloads stored object bytes up to maxSize (including maxSize: 0 for 0-byte objects) and throws StorageErrorCode.downloadSizeExceeded when the object exceeds maxSize.",
  featureKeys: ["downloadSizeExceeded", "zeroByteMultiChunkDataAndMaxSizeBoundariesOverHostedRuntime"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift` (zeroBytePutDataAndZeroMaxSizeBoundary), `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (zeroByteMultiChunkDataAndMaxSizeBoundariesOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
