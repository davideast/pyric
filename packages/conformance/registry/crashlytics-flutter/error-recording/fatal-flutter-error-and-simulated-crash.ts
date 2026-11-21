import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "recordFlutterFatalError(FlutterErrorDetails) / crash() / didCrashOnPreviousExecution()",
  behavior: "Records fatal framework errors via recordFlutterFatalError, throws a deterministic CrashlyticsSimulatedCrashError (StateError) after queuing a fatal report on crash(), and flips didCrashOnPreviousExecution() to true.",
  featureKeys: ["FirebaseCrashlytics.recordFlutterFatalError", "FirebaseCrashlytics.crash", "FirebaseCrashlytics.didCrashOnPreviousExecution", "CrashlyticsSimulatedCrashError"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
