import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Tool.functionDeclarations(_:) / FunctionDeclaration / ToolConfig / FunctionCallingConfig / FunctionCallPart / FunctionResponsePart",
  behavior: "Executes multi-turn function calling, exposing response.functionCalls with functionId and thoughtSignature and replaying FunctionResponsePart turns.",
  featureKeys: ["Tool.functionDeclarations", "FunctionDeclaration", "ToolConfig", "FunctionCallingConfig", "FunctionCallPart", "FunctionResponsePart"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
