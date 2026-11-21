import { row } from './section.ts';

export default row({
  order: 30,
  api: "Tool.googleSearch() / Tool.codeExecution() / RetrievalConfig / ImageConfig",
  behavior: "Serializes googleSearch, codeExecution, RetrievalConfig (latLng and languageCode), and ImageConfig wire fields on GenerateContentRequest.",
  featureKeys: ["Tool.googleSearch", "Tool.codeExecution", "RetrievalConfig", "ImageConfig"],
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (requestConfigurationSerialization).",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
  ],
});
