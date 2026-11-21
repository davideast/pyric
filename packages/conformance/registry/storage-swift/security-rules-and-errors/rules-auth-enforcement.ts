import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Storage Security Rules & FirebaseAuth / AuthLens coupling",
  behavior: "Evaluates per-bucket Storage Security Rules (request.auth and request.resource size and contentType checks), denying unauthenticated, cross-UID, or post-signOut() access with StorageErrorCode.unauthorized.",
  featureKeys: ["unauthorized", "enforcesRulesAndExecutesFullStorageCrudOverHostedRuntime"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift` (enforcesRulesAndExecutesFullStorageCrudOverHostedRuntime) and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (partialUpdateMetadataPreservesResourceContextInStorageRules).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
