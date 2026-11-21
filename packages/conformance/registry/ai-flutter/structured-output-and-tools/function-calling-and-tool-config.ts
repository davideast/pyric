import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Tool.functionDeclarations / FunctionDeclaration / ToolConfig / FunctionCallingConfig / FunctionCall / Content.functionResponse",
  behavior: "Decodes FunctionCall parts (id, name, args, thoughtSignature) and threads Content.functionResponse follow-up turns normalized to role user.",
  featureKeys: ["Tool.functionDeclarations", "FunctionDeclaration", "ToolConfig", "FunctionCallingConfig", "FunctionCall", "Content.functionResponse"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_schema_and_tools_test.dart`, `packages/flutter-client/test/ai/ai_chat_session_test.dart`, and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/ai_schema_and_tools_test.dart",
    "packages/flutter-client/test/ai/ai_chat_session_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
