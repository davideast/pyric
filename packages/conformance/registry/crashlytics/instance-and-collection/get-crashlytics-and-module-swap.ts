import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "getCrashlytics(app?, options?) / firebase/crashlytics specifier mapping",
  behavior: "Caches per-FirebaseApp and per-Sandbox Crashlytics instances with region, appVersion, and customAttributes options, and swaps firebase/crashlytics imports to pyric/crashlytics across register, Next.js aliases, import maps, and served SDK entries.",
  featureKeys: ["getCrashlytics", "Crashlytics", "CrashlyticsOptions"],
  status: "conforms",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` and `packages/cli/test/serve/crashlytics-bridge.test.ts` (`maps firebase/crashlytics across register, Next.js aliases, import map, and SDK bundler entries`).",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
