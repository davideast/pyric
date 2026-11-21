import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.child(_:) / parent() / root() / fullPath / name / bucket",
  behavior: "Navigates object hierarchies with nil parent() at root, gs://<bucket>/<fullPath> description, NSCopying, and value equality and hashing.",
  featureKeys: ["fullPath", "referenceHierarchyAndURLParsing"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift` (referenceHierarchyAndURLParsing) and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
