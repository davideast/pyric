import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "GenerativeModel.generateContentStream(...) / Flow<GenerateContentResponse>",
  behavior: "Streams ordered GenerateContentResponse chunks over worker-sub and immediately sends worker-unsub on Flow.take(N) or coroutine cancellation without disturbing sibling streams.",
  featureKeys: ["GenerativeModel.generateContentStream"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/AiStreamSubscriptionTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/ai/ConcurrentStreamCancellationTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConcurrencyConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/AiStreamSubscriptionTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/ConcurrentStreamCancellationTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConcurrencyConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
