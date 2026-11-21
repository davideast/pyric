import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseCrashlytics.log(message) / setUserIdentifier(identifier)",
  behavior: "Records per-app user identifiers and FIFO log breadcrumbs over crashlytics.setUserId and crashlytics.log, attaching captured breadcrumbs to subsequent error reports.",
  featureKeys: ["FirebaseCrashlytics.log", "FirebaseCrashlytics.setUserIdentifier"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
