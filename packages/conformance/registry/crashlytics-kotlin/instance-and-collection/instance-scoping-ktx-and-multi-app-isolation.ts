import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseCrashlytics.getInstance() / getInstance(app) / Firebase.crashlytics / clearInstancesForTest()",
  behavior: "Caches per-FirebaseApp FirebaseCrashlytics instances, exposes Firebase.crashlytics and Firebase.crashlytics(app) KTX extensions, omits appId on [DEFAULT], and isolates named-app state on CrashlyticsBroker.",
  featureKeys: ["FirebaseCrashlytics.getInstance", "Firebase.crashlytics", "FirebaseCrashlytics.clearInstancesForTest"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
