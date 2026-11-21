import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Undeployed custom gs:// bucket fail-closed rules",
  behavior: "Denies client operations targeting a custom gs:// bucket that has no deployed Storage Security Rules with StorageErrorCode.unauthorized.",
  featureKeys: ["undeployedStorage"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (customGsBucketIsolationOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
