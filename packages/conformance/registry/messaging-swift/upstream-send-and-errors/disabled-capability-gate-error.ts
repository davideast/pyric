import { row } from './section.ts';

export default row({
  order: 30,
  api: "MessagingError.disabled (code == .disabled / messaging/disabled capability gate)",
  behavior: "Surfaces deterministic MessagingError.disabled capability-gate rejections when HostedRuntime omits messaging: true on the bridge.",
  featureKeys: ["MessagingError.disabled"],
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
  ],
});
