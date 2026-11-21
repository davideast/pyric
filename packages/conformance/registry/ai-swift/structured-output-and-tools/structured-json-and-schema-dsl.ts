import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Schema (string, integer, float, double, boolean, enumeration, array, object, anyOf, toJSONSchema()) / responseMIMEType / responseSchema",
  behavior: "Encodes Gemini OpenAPI Schema definitions and synthesizes structured application/json responses decoded into Codable or JSONObject values.",
  featureKeys: ["Schema", "Schema.object", "Schema.anyOf", "Schema.toJSONSchema"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift` (schemaDslEncoding) and `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
