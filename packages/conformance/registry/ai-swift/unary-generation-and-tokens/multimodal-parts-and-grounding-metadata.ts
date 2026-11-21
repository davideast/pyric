import { row } from './section.ts';

export default row({
  order: 40,
  api: "InlineDataPart / FileDataPart / ExecutableCodePart / CodeExecutionResultPart / CitationMetadata / GroundingMetadata",
  behavior: "Round-trips binary InlineDataPart, FileDataPart, ExecutableCodePart, and CodeExecutionResultPart wire envelopes and decodes CitationMetadata and GroundingMetadata.",
  featureKeys: ["InlineDataPart", "FileDataPart", "ExecutableCodePart", "CodeExecutionResultPart", "CitationMetadata", "GroundingMetadata"],
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (modelContentAndPartWireRoundTrip and responseHelpersAndErrorCases).",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
  ],
});
