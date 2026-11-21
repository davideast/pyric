import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.updateMetadata(_:)",
  behavior: "Patches settable HTTP headers and customMetadata, preserves existing size and contentType when Storage Security Rules inspect request.resource, and increments metageneration.",
  featureKeys: ["updateMetadata", "partialUpdateMetadataPreservesResourceContextInStorageRules"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift` (updateMetadataRulesGateMergesExistingResourceFields), `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (partialUpdateMetadataPreservesResourceContextInStorageRules).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
