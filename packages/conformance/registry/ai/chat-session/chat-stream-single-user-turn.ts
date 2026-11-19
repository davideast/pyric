import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 60,
  featureKeys: ['sendMessageStream'],
  api: 'ChatSession.sendMessageStream()',
  behavior:
    'Exactly one user turn is recorded per `sendMessageStream` call (`historyRolesAfterStream: ["user", "model"]`)',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-sdk-chat-session-send-and-stream` (`userTurnCountAfterStream: 1`, `historyRolesAfterStream: ["user", "model"]`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `chat-session.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-sdk-chat-session-send-and-stream'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'chat-session.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-CHAT-STREAM-SINGLE-USER-TURN',
      observation: 'ai-sdk-chat-session-send-and-stream',
      expect: { model: 'gemini-flash-lite-latest' },
      probe: PROBE,
      guards: 'ChatSession.sendMessageStream records exactly one user turn and one model turn per streaming call.',
    },
  ],
  notes:
    'Installed `firebase` 12.19.0 (`@firebase/ai` 2.16.0) fixed the earlier 2.12.0 duplicate-user-turn bug; both upstream and Pyric record `userTurnCountAfterStream: 1` (`packages/pyric/src/ai/models.ts`).',
});
