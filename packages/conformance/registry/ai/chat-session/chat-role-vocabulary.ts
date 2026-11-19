import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/chat-errors-abort-oracle.test.ts';

export default row({
  order: 70,
  featureKeys: ['POSSIBLE_ROLES'],
  api: 'POSSIBLE_ROLES',
  behavior: '`POSSIBLE_ROLES` is exactly `["user", "model", "function", "system"]`',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-offline-chat-roles-errors-and-abort` replayed across in-process (`chat-errors-abort-oracle.test.ts`), worker-host (`ai-chat-errors-abort.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-offline-chat-roles-errors-and-abort'],
  conformanceTests: ['chat-errors-abort-oracle.test.ts', 'chat-session.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-chat-errors-abort.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-CHAT-ROLE-VOCABULARY',
      observation: 'ai-offline-chat-roles-errors-and-abort',
      expect: { possibleRoles: ['user', 'model', 'function', 'system'] },
      probe: PROBE,
      guards: 'POSSIBLE_ROLES matches the exact 4-role client constant tuple in order.',
    },
  ],
});
