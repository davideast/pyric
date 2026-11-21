import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Tool.functionDeclarations / FunctionDeclaration / ToolConfig / FunctionCallingConfig / FunctionCallPart / FunctionResponsePart",
  behavior: "Executes AUTO and forced ANY function-calling loops, exposing response.functionCalls and preserving broker-minted thoughtSignature across FunctionResponsePart turns.",
  featureKeys: ["Tool.functionDeclarations", "FunctionDeclaration", "ToolConfig", "FunctionCallingConfig", "FunctionCallPart", "FunctionResponsePart"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiSchemaAndToolTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiSchemaAndToolTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
