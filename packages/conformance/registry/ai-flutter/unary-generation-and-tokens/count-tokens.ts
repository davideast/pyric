import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: "GenerativeModel.countTokens(...) / CountTokensResponse",
  behavior: "Computes deterministic prompt and systemInstruction token counts via ai.countTokens across Google AI and Vertex AI models, rejecting empty contents with HTTP 400 invalid-argument.",
  featureKeys: ["GenerativeModel.countTokens", "CountTokensResponse"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/generative_model_unary_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/generative_model_unary_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
