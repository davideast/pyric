import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 20,
  featureKeys: ['sendMessage', 'getHistory'],
  api: 'ChatSession.sendMessage() / getHistory()',
  behavior:
    '`sendMessage` appends the user turn and the model turn; `getHistory()` returns the ordered `Content[]` with alternating roles',
  status: 'diverged-documented',
  statusNote: 'clone',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-sdk-chat-session-send-and-stream` (`historyRolesAfterSend: ["user", "model"]`, `getHistoryReturnsSameArrayReference: true`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `chat-session.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-sdk-chat-session-send-and-stream'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'chat-session.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-CHAT-HISTORY-THREADS',
      observation: 'ai-sdk-chat-session-send-and-stream',
      expect: { model: 'gemini-flash-lite-latest' },
      probe: PROBE,
      guards: 'ChatSession.sendMessage appends alternating user and model turns while getHistory() returns a defensive clone.',
    },
  ],
  notes:
    'Pinned delta vs installed 2.12.0 and 2.16.0 (`firebase` 12.19.0): `getHistory()` returns a defensive clone so caller mutations never corrupt the session, whereas upstream hands out its live history array (`getHistoryReturnsSameArrayReference: true` in `ai-sdk-chat-session-send-and-stream`, `packages/pyric/src/ai/models.ts`).',
});
