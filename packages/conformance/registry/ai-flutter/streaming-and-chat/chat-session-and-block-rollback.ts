import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "GenerativeModel.startChat(...) / ChatSession.sendMessage(...) / ChatSession.sendMessageStream(...) / ChatSession.history",
  behavior: "Appends user and aggregated model turns atomically on clean non-blocked completion while excluding SAFETY-blocked turns from ChatSession.history.",
  featureKeys: ["GenerativeModel.startChat", "ChatSession", "ChatSession.sendMessage", "ChatSession.sendMessageStream", "ChatSession.history"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_chat_session_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/ai_chat_session_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
