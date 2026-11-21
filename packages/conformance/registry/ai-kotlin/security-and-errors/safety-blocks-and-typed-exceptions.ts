import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "PromptBlockedException / ResponseStoppedException / QuotaExceededException / InvalidAPIKeyException / ServerException",
  behavior: "Throws typed FirebaseAIException subclasses for promptFeedback.blockReason, non-STOP candidate FinishReason (SAFETY), 429 RESOURCE_EXHAUSTED, invalid API keys, and disallowed content roles.",
  featureKeys: ["FirebaseAIException", "PromptBlockedException", "ResponseStoppedException", "QuotaExceededException", "InvalidAPIKeyException", "ServerException"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt` (blockedFinishReasonsBlockedPromptsAndBrokerWireErrorsThrowTypedExceptions).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
