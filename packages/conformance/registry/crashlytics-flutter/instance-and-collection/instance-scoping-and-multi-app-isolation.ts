import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseCrashlytics.instance / instanceFor({app}) / registerWith / clearInstancesForTest",
  behavior: "Caches per-FirebaseApp FirebaseCrashlytics instances, omits appId on [DEFAULT], isolates secondary app state on CrashlyticsBroker, and resets instances via clearInstancesForTest().",
  featureKeys: ["FirebaseCrashlytics.instance", "FirebaseCrashlytics.instanceFor", "FirebaseCrashlytics.registerWith", "FirebaseCrashlytics.clearInstancesForTest"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
