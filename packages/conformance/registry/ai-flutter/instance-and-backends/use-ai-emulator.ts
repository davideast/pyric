import { row } from './section.ts';

export default row({
  order: 40,
  api: "FirebaseAI.useAIEmulator(host, port)",
  behavior: "Validates non-empty host and 1..65535 port bounds, brackets IPv6 hosts, disconnects previously owned bridge clients, and connects to ws://<host>:<port>/__pyric/sandbox.",
  featureKeys: ["FirebaseAI.useAIEmulator"],
  evidence: "Verified in `packages/flutter-client/test/ai/firebase_ai_test.dart` (validates useAIEmulator host and port boundaries).",
  tests: [
    "packages/flutter-client/test/ai/firebase_ai_test.dart",
  ],
});
