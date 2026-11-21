import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseAI local Pyric WebSocket bridge transport",
  behavior: "Dispatches ai.generateContent, ai.countTokens, and streamGenerateContent subscriptions over the local Pyric WebSocket bridge (ws://<host>:<port>/__pyric/sandbox) instead of external Google AI or Vertex AI HTTPS endpoints.",
  featureKeys: ["FirebaseAI.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of sending HTTPS requests to external Gemini Developer API or Vertex AI endpoints, `pyric_ai` routes `worker-op` and `worker-sub` frames over the local Pyric WebSocket bridge to `AiBroker`. Verified in `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/firebase_ai_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
