import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseAI(useLimitedUseAppCheckTokens) + FirebaseAppCheck token attachment",
  behavior: "Attaches cached standard or fresh single-use RS256 App Check JWTs onto unary and streaming AI frames and surfaces broker 401 UNAUTHENTICATED rejections for forged tokens.",
  featureKeys: ["FirebaseAI.useLimitedUseAppCheckTokens"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt` (verifiesStandardLimitedUseAndRejectedAppCheckClaimsAgainstLiveAiBroker).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
