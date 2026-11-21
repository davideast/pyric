import { row } from './section.ts';

export default row({
  order: 30,
  api: "GenerateContentError.promptBlocked(response:) / EmptyContentError / RequestOptions(timeout:)",
  behavior: "Throws GenerateContentError.promptBlocked when promptFeedback.blockReason is set, throws EmptyContentError when candidates contain no usable parts, and forwards RequestOptions.timeout.",
  featureKeys: ["GenerateContentError.promptBlocked", "EmptyContentError", "RequestOptions"],
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (responseHelpersAndErrorCases).",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
  ],
});
