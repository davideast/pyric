import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Schema (string, integer, long, float, double, boolean, enumeration, array, obj, anyOf) / responseMimeType / responseSchema",
  behavior: "Encodes Gemini Schema trees (required, optionalProperties, propertyOrdering, anyOf) and synthesizes structured application/json responses on unary and streaming calls.",
  featureKeys: ["Schema", "Schema.obj", "Schema.anyOf", "GenerationConfig.responseSchema"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiSchemaAndToolTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt` (structuredJsonResponseSchemaAndForcedToolConfigAnySynthesizeLiveBrokerShapes).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiSchemaAndToolTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
