import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseCrashlytics.flush() / getState()",
  behavior: "Awaits all preceding serialized Crashlytics coroutine operations via flush() and retrieves inspectable per-app broker state via getState().",
  featureKeys: ["FirebaseCrashlytics.flush", "FirebaseCrashlytics.getState"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
