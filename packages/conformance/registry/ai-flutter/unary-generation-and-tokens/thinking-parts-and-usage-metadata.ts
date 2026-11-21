import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "ThoughtPart / GenerateContentResponse.thoughtSummary / UsageMetadata",
  behavior: "Filters ThoughtPart entries out of response.text into thoughtSummary, preserves thoughtSignature across turns, and decodes UsageMetadata (promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount).",
  featureKeys: ["ThoughtPart", "GenerateContentResponse.thoughtSummary", "UsageMetadata"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_wire_codec_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/ai_wire_codec_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
