import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "GenerativeModel.generateContent(...) / generationConfig { ... } / SafetySetting / systemInstruction",
  behavior: "Executes unary ai.generateContent across String, vararg Content, and List<Content> prompts with GenerationConfig, SafetySetting, and systemInstruction, decoding modelVersion, responseId, and FinishReason.",
  featureKeys: ["GenerativeModel.generateContent", "GenerationConfig", "SafetySetting"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelUnaryWireTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelUnaryWireTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
