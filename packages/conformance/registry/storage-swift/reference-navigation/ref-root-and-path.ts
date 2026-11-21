import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "storage.reference() / storage.reference(withPath:)",
  behavior: "Creates root (fullPath == \"\") and slash-normalized relative StorageReference handles preserving Unicode and percent-reserved path characters.",
  featureKeys: ["reference", "unicodeAndSlashNormalizedPathsOverHostedRuntime"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift` (referenceHierarchyAndURLParsing) and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (unicodeAndSlashNormalizedPathsOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
