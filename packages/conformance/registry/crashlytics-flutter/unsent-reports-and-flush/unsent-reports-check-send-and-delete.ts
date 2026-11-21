import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "checkForUnsentReports() / sendUnsentReports() / deleteUnsentReports()",
  behavior: "Routes errors recorded while collection is disabled into unsentReports and supports checking, promoting via sendUnsentReports(), and discarding via deleteUnsentReports().",
  featureKeys: ["FirebaseCrashlytics.checkForUnsentReports", "FirebaseCrashlytics.sendUnsentReports", "FirebaseCrashlytics.deleteUnsentReports"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
