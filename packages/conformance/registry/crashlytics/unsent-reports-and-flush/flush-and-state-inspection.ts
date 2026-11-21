import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "flush(crashlytics) / crashlytics.flush / crashlytics.getState",
  behavior: "Drains all in-flight client log and recordError promises before marking queued reports flushed: true on CrashlyticsBroker and exposing inspectable per-app logs, reports, and unsentReports via crashlytics.getState.",
  featureKeys: ["flush", "CrashlyticsAppState", "CrashlyticsReport"],
  status: "conforms",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` and `packages/cli/test/serve/crashlytics-bridge.test.ts`.",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
