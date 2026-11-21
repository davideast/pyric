import { row } from './section.ts';

export default row({
  order: 30,
  api: "Chat concurrent in-flight turn guard (InvalidStateException)",
  behavior: "Rejects overlapping sendMessage or sendMessageStream calls on the same Chat instance with InvalidStateException and releases the turn lock after completion or failure.",
  featureKeys: ["InvalidStateException"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/ChatSessionAndFunctionCallTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/ChatSessionAndFunctionCallTest.kt",
  ],
});
