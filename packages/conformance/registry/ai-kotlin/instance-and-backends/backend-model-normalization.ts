import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "GenerativeBackend.googleAI() / GenerativeBackend.vertexAI(location) / generativeModel(modelName, ...)",
  behavior: "Normalizes bare and prefixed Gemini model identifiers to models/<id> on Google AI and publishers/google/models/<id> on Vertex AI without double-prefixing.",
  featureKeys: ["GenerativeBackend.googleAI", "GenerativeBackend.vertexAI", "FirebaseAI.generativeModel"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiInstanceAndDslTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt` (unaryGenerateContentAndCountTokensRoundTripAcrossGoogleAiAndVertexAiBackends).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiInstanceAndDslTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
