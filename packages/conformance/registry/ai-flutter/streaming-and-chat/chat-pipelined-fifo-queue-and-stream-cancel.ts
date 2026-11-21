import { row } from './section.ts';

export default row({
  order: 30,
  api: "ChatSession FIFO pipelined turn queue, lazy onListen reservation, and mid-stream cancel rollback",
  behavior: "Serializes pipelined sendMessageStream and sendMessage turns in FIFO order, defers queue reservation until Stream.listen, and excludes cancelled or mid-stream errored turns without poisoning later turns.",
  featureKeys: ["ChatSession.pipelining"],
  evidence: "Verified in `packages/flutter-client/test/ai/ai_chat_session_test.dart` (defensively clones initial history, serializes pipelined turns in FIFO order, and excludes PromptFeedback blocks).",
  tests: [
    "packages/flutter-client/test/ai/ai_chat_session_test.dart",
  ],
});
