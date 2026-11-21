import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseAI(appCheck, useLimitedUseAppCheckTokens) + PyricFirebaseAppCheckPlatform",
  behavior: "Attaches cached standard or single-use RS256 App Check JWTs onto unary and streaming AI frames and rejects unactivated (null) or forged tokens with HTTP 401 unauthenticated FirebaseAIException.",
  featureKeys: ["FirebaseAI.useLimitedUseAppCheckTokens"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/generative_model_unary_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart` (enforces RS256 App Check tokens across missing, forged, standard, and limited-use claims).",
  tests: [
    "packages/flutter-client/test/ai/generative_model_unary_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
