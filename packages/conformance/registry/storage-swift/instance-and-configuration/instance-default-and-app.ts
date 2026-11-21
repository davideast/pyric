import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Storage.storage() / Storage.storage(app:)",
  behavior: "Returns cached Storage instances scoped per FirebaseApp and default bucket, with Storage.reset() evicting cached instances.",
  featureKeys: ["storage", "instanceCachingPerAppAndPerBucket"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift` (instanceCachingPerAppAndPerBucket) and `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
