import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "CrashlyticsBroker (setCollectionEnabled, checkForUnsentReports, sendUnsentReports, deleteUnsentReports, setUserId, setCustomKeys)",
  behavior: "Executes all 10 shared crashlytics.* wire operations on HostedRuntime, routing reports recorded while collectionEnabled is false into unsentReports until sendUnsentReports promotes them or deleteUnsentReports discards them.",
  featureKeys: ["CrashlyticsBroker"],
  status: "conforms",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` and `packages/cli/test/serve/crashlytics-bridge.test.ts`.",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
