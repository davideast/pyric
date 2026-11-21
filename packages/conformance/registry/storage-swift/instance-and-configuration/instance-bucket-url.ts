import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Storage.storage(url:) / Storage.storage(app:url:)",
  behavior: "Resolves bucket-isolated Storage instances for custom gs://<bucket> URLs, enforcing bucket-scoped wire parameters and Security Rules.",
  featureKeys: ["namedBucketWireIsolation", "customGsBucketIsolationOverHostedRuntime"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift` (namedBucketWireIsolation) and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (customGsBucketIsolationOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
