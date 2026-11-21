import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseAI.generativeModel(model: ...)",
  behavior: "Normalizes bare and prefixed Gemini model identifiers to models/<id> on Google AI and publishers/google/models/<id> on Vertex AI, and rejects blank model names with FirebaseAIException(code: 'no-model').",
  featureKeys: ["FirebaseAI.generativeModel"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/firebase_ai_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/firebase_ai_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
