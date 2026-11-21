import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseCrashlytics App Check bridge token attachment",
  behavior: "Automatically mints and attaches a valid RS256 appCheckToken from a registered FirebaseAppCheck provider onto every crashlytics.* worker-op envelope.",
  featureKeys: ["FirebaseCrashlytics.appCheckTokenAttachment"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt` and `packages/cli/test/serve/native-kotlin-crashlytics-conformance.test.ts`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/CrashlyticsLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
