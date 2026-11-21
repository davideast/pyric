import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "MessagingError (.invalidRequest, brokerStatus == 'NOT_FOUND', CustomNSError)",
  behavior: "Maps revoked-token and unregistered-target broker rejections to typed MessagingError values exposing CustomNSError errorDomain, errorCode, and brokerStatus == 'NOT_FOUND'.",
  featureKeys: ["MessagingError", "MessagingError.Code"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` and `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
