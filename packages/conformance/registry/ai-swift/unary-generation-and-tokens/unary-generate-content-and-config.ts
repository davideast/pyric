import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "GenerativeModel.generateContent(_:) / GenerationConfig / SafetySetting / systemInstruction",
  behavior: "Executes unary ai.generateContent across PartsRepresentable varargs and [ModelContent] arrays with GenerationConfig, SafetySetting, and roleless systemInstruction serialization.",
  featureKeys: ["GenerativeModel.generateContent", "GenerationConfig", "SafetySetting", "ModelContent"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift` (fullLiveHostAiLogicWorkflow).",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
