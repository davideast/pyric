import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseAI.instance / FirebaseAI.getInstance(...) / Firebase.ai(...) / reset()",
  behavior: "Caches FirebaseAI instances per (FirebaseApp, GenerativeBackend, useLimitedUseAppCheckTokens) with Firebase.ai KTX extensions and FirebaseAI.reset() teardown.",
  featureKeys: ["FirebaseAI.instance", "FirebaseAI.getInstance", "Firebase.ai", "FirebaseAI.reset"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiInstanceAndDslTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiInstanceAndDslTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
