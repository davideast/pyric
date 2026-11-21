import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Schema (string, enumString, integer, number, boolean, array, object, anyOf) / responseMimeType / responseSchema",
  behavior: "Serializes Gemini Schema definitions (required, optionalProperties, propertyOrdering, anyOf) and synthesizes structured application/json responses.",
  featureKeys: ["Schema", "Schema.object", "Schema.enumString", "Schema.anyOf"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_schema_and_tools_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/ai_schema_and_tools_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
