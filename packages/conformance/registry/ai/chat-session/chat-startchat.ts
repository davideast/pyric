import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/chat-errors-abort-oracle.test.ts';

export default row({
  order: 10,
  featureKeys: ['startChat'],
  api: 'GenerativeModel.startChat()',
  behavior: '`startChat` returns a `ChatSession` seeded with `StartChatParams.history`',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-offline-chat-roles-errors-and-abort` replayed across in-process (`chat-errors-abort-oracle.test.ts`), worker-host (`ai-chat-errors-abort.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-offline-chat-roles-errors-and-abort'],
  conformanceTests: [
    'chat-errors-abort-oracle.test.ts',
    'upstream-ai-probes.test.ts',
    'chat-session.test.ts',
  ],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-chat-errors-abort.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-CHAT-STARTCHAT',
      observation: 'ai-offline-chat-roles-errors-and-abort',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards:
        'startChat returns a ChatSession seeded with valid user/model/function history and throws AIError (invalid-content) on invalid history.',
    },
  ],
});
