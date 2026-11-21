import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "GenerateContentError (.responseStoppedEarly, .internalError) / BackendError / RPCStatus",
  behavior: "Throws GenerateContentError.responseStoppedEarly(reason:response:) on non-stop candidate finish reasons (.safety) and wraps wire RPC failures in BackendError with HTTP status and CustomNSError metadata.",
  featureKeys: ["GenerateContentError", "BackendError", "RPCStatus"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (responseHelpersAndErrorCases) and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
