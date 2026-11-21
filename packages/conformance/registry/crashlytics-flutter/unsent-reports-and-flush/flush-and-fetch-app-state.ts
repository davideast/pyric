import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "flush() / getState() / fetchAppState() / CrashlyticsAppState",
  behavior: "Drains in-flight asynchronous operations before dispatching crashlytics.flush and decodes typed CrashlyticsAppState snapshots via fetchAppState().",
  featureKeys: ["FirebaseCrashlytics.flush", "FirebaseCrashlytics.getState", "FirebaseCrashlytics.fetchAppState", "CrashlyticsAppState"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
