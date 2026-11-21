import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "log(crashlytics, message, attributes?) / breadcrumbs()",
  behavior: "Appends timestamped log entries to the 256-entry per-app ring buffer, merges call-level Attributes over CrashlyticsOptions.customAttributes, and snapshots breadcrumbs onto subsequent error reports when breadcrumbs() is enabled.",
  featureKeys: ["log", "breadcrumbs", "CrashlyticsFeature", "Attributes"],
  status: "conforms",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` and `packages/cli/test/serve/crashlytics-bridge.test.ts` (`streams Web getCrashlytics -> log -> recordError -> flush and native 10-op wire lifecycle over HostedRuntime`).",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
