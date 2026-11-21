import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "recordError(exception, stack, {reason, information, fatal}) / recordFlutterError(FlutterErrorDetails)",
  behavior: "Extracts FirebaseException plugin/code identifiers, DiagnosticsNode reason and informationCollector lines, and Dart stack traces into sdkPlatform == 'flutter' reports.",
  featureKeys: ["FirebaseCrashlytics.recordError", "FirebaseCrashlytics.recordFlutterError"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
