import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "checkForUnsentReports() / sendUnsentReports() / deleteUnsentReports()",
  behavior: "Queues exceptions recorded while collection is disabled into unsentReports, resolves checkForUnsentReports() to true, and promotes or discards queued reports via sendUnsentReports() and deleteUnsentReports().",
  featureKeys: ["FirebaseCrashlytics.checkForUnsentReports", "FirebaseCrashlytics.sendUnsentReports", "FirebaseCrashlytics.deleteUnsentReports"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
