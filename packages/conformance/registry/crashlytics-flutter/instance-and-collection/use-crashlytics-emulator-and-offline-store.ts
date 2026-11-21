import { row } from './section.ts';

export default row({
  order: 40,
  api: "useCrashlyticsEmulator(host, port) / useEmulator(host, port) / offline store fallback",
  behavior: "Connects a dedicated PyricBridgeClient via useCrashlyticsEmulator (rejecting empty hosts or non-positive ports with invalid-argument) and falls back to CrashlyticsLocalStore when no bridge host is attached.",
  featureKeys: ["FirebaseCrashlytics.useCrashlyticsEmulator", "FirebaseCrashlytics.useEmulator", "CrashlyticsLocalStore"],
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` (`supports full offline workflow without an active WebSocket host` and `normalizes non-finite doubles and rejects empty keys or invalid types`).",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
  ],
});
