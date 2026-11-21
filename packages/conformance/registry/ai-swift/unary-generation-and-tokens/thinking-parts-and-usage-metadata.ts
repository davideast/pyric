import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "ThinkingConfig / GenerateContentResponse.thoughtSummary / GenerateContentResponse.text / UsageMetadata",
  behavior: "Excludes isThought parts from response.text, aggregates reasoning text into thoughtSummary, and decodes UsageMetadata token counts and ModalityTokenCount details.",
  featureKeys: ["ThinkingConfig", "GenerateContentResponse.thoughtSummary", "UsageMetadata"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (responseHelpersAndErrorCases) and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
