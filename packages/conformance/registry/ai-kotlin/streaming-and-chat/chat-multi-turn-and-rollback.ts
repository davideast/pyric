import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "GenerativeModel.startChat(history) / Chat.sendMessage(...) / Chat.sendMessageStream(...) / Chat.history",
  behavior: "Maintains immutable point-in-time Chat.history snapshots, coalesces completed streaming turns with thoughtSignature preservation, and excludes blocked, empty-candidate, errored, or early-cancelled turns.",
  featureKeys: ["GenerativeModel.startChat", "Chat", "Chat.sendMessage", "Chat.sendMessageStream", "Chat.history"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/ChatSessionAndFunctionCallTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConcurrencyConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/ChatSessionAndFunctionCallTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConcurrencyConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
