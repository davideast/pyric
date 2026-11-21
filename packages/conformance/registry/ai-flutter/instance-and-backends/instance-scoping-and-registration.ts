import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseAI.googleAI(...) / FirebaseAI.vertexAI(...) / FirebaseAI.registerWith(...) / clearInstancesForTest()",
  behavior: "Caches FirebaseAI instances per (FirebaseApp, backendType, location, useLimitedUseAppCheckTokens), shares registered PyricBridgeClient or activated PyricFirebaseAppCheckPlatform transports, and disconnects owned transports on teardown.",
  featureKeys: ["FirebaseAI.googleAI", "FirebaseAI.vertexAI", "FirebaseAI.registerWith"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/firebase_ai_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/firebase_ai_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
