import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "setUserId(identifier) / setCustomKey(...) / setCustomKeys(CustomKeysAndValues) / setCustomKeys { key(...) }",
  behavior: "Sets per-app user identifiers and typed Boolean, Int, Long, Float, Double, and String custom keys via overloaded setters, CustomKeysAndValues.Builder, and the KeyValueBuilder KTX DSL.",
  featureKeys: ["FirebaseCrashlytics.setUserId", "FirebaseCrashlytics.setCustomKey", "FirebaseCrashlytics.setCustomKeys", "CustomKeysAndValues", "KeyValueBuilder"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
