import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Content.multi(...) / InlineDataPart / GenerateContentResponse.inlineDataParts / candidateCount",
  behavior: "Encodes binary InlineDataPart payloads as base64 on the wire and decodes returned inlineDataParts bytes and multi-candidate responses (candidateCount > 1).",
  featureKeys: ["Content.multi", "InlineDataPart", "GenerateContentResponse.inlineDataParts"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_multimodal_and_candidates_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart` (round-trips multimodal InlineDataPart, candidateCount > 1 with ThoughtPart filtering).",
  tests: [
    "packages/flutter-client/test/ai/ai_multimodal_and_candidates_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
