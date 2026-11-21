import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseAI local Pyric WebSocket bridge transport",
  behavior: "Routes ai.generateContent, ai.countTokens, and streamGenerateContent subscriptions over the local Pyric WebSocket bridge instead of external Gemini or Vertex AI cloud HTTPS endpoints.",
  featureKeys: ["FirebaseAI.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of sending HTTPS requests to `generativelanguage.googleapis.com` or `firebasevertexai.googleapis.com`, `FirebaseAI` dispatches `worker-op` and `worker-sub` frames over the local Pyric WebSocket bridge (`/__pyric/sandbox`) to `AiBroker`. Verified in `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiInstanceAndDslTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
