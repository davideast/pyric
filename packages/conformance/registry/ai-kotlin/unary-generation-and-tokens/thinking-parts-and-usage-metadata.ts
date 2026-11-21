import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "ThinkingConfig / thinkingConfig { ... } / GenerateContentResponse.thoughtSummary / UsageMetadata",
  behavior: "Filters isThought parts out of response.text and inlineDataParts into thoughtSummary, preserves thoughtSignature on multi-turn replay, and decodes UsageMetadata modality token counts.",
  featureKeys: ["ThinkingConfig", "GenerateContentResponse.thoughtSummary", "UsageMetadata"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/ThoughtFilteringAndUsageMetadataTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostHardeningConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/ThoughtFilteringAndUsageMetadataTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostHardeningConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
