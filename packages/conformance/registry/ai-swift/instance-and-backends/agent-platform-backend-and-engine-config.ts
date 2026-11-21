import { row } from './section.ts';

export default row({
  order: 40,
  api: "Backend.agentPlatform(location:) / PyricAIEngineConfig (.scripted, .openai, .gemini)",
  behavior: "Configures Backend.agentPlatform(location:) defaulting to global and serializes per-instance PyricAIEngineConfig overrides onto outbound AI bridge frames.",
  featureKeys: ["Backend.agentPlatform", "PyricAIEngineConfig"],
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (instanceCachingAndModelNormalization and requestConfigurationSerialization).",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
  ],
});
