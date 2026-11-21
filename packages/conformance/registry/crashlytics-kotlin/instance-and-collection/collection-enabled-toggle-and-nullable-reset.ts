import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "isCrashlyticsCollectionEnabled() / setCrashlyticsCollectionEnabled(Boolean) / setCrashlyticsCollectionEnabled(Boolean?)",
  behavior: "Toggles Crashlytics report collection per app and restores the FirebaseApp.isDataCollectionDefaultEnabled fallback when passed a null Boolean? override.",
  featureKeys: ["FirebaseCrashlytics.isCrashlyticsCollectionEnabled", "FirebaseCrashlytics.setCrashlyticsCollectionEnabled"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
