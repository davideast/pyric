import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "GenerativeModel.generateContent(...) / GenerationConfig / SafetySetting / Content.system(...)",
  behavior: "Dispatches ai.generateContent with model-level and per-call GenerationConfig, SafetySetting, and systemInstruction, decoding modelVersion, responseId, and GenerateContentResponse envelopes.",
  featureKeys: ["GenerativeModel.generateContent", "GenerationConfig", "SafetySetting", "Content.system"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/generative_model_unary_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/generative_model_unary_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
