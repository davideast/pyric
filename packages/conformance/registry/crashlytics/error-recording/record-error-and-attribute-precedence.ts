import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "recordError(crashlytics, error, attributes?)",
  behavior: "Normalizes Error and non-Error values (preserving name, message, stack, code, and chained cause), merges call-level attributes over base customAttributes, attaches captured breadcrumbs, and records sdkPlatform: 'web' reports on CrashlyticsBroker.",
  featureKeys: ["recordError", "CrashlyticsAttributes", "AttributeValue"],
  status: "conforms",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` and `packages/cli/test/serve/crashlytics-bridge.test.ts`.",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
