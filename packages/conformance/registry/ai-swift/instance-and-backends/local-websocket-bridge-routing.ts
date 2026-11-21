import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseAI + FirebaseApp.useEmulator(withHost:port:) WebSocket bridge transport",
  behavior: "Routes ai.generateContent, ai.countTokens, and streamGenerateContent subscriptions over the local Pyric WebSocket bridge (ws://<host>:<port>/__pyric/sandbox) instead of cloud Gemini or Vertex AI HTTPS endpoints.",
  featureKeys: ["FirebaseAI.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of sending HTTPS requests to external Google AI or Vertex AI endpoints, `PyricAI` dispatches `worker-op` and `worker-sub` frames over the local Pyric WebSocket bridge bound via `app.useEmulator(withHost:port:)`. Verified in `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricAITests/PyricAIUnitTests.swift",
    "packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
