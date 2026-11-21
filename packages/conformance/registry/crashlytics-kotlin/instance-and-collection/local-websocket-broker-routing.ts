import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseCrashlytics local Pyric WebSocket bridge transport",
  behavior: "Routes logs, custom keys, user IDs, recorded exceptions, and unsent-report operations over /__pyric/sandbox to CrashlyticsBroker instead of Android NDK/ANR signal handlers and firebasecrashlytics.googleapis.com.",
  featureKeys: ["FirebaseCrashlytics.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of installing native Android signal handlers or uploading crash sessions to Google servers, `FirebaseCrashlytics` dispatches `crashlytics.*` `worker-op` frames over the local Pyric WebSocket bridge. Verified in `packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
