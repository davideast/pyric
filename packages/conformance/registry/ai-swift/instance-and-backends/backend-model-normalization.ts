import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Backend.googleAI() / Backend.vertexAI(location:) / generativeModel(modelName:...)",
  behavior: "Normalizes bare and prefixed Gemini model names to models/<id> on Google AI and publishers/google/models/<id> on Vertex AI without double-prefixing.",
  featureKeys: ["Backend.googleAI", "Backend.vertexAI", "FirebaseAI.generativeModel"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (wireModelNameNormalization) and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
