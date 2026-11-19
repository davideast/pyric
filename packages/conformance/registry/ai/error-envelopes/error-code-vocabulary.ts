import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/chat-errors-abort-oracle.test.ts';

export default row({
  order: 80,
  featureKeys: ['AIErrorCode'],
  api: 'AIErrorCode',
  behavior: '`AIErrorCode` exposes the 14 documented codes, from `error` through `unsupported`',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-offline-chat-roles-errors-and-abort` replayed across in-process (`chat-errors-abort-oracle.test.ts`), worker-host (`ai-chat-errors-abort.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-offline-chat-roles-errors-and-abort'],
  conformanceTests: ['chat-errors-abort-oracle.test.ts', 'errors-counttokens.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-chat-errors-abort.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-ERROR-CODE-VOCABULARY',
      observation: 'ai-offline-chat-roles-errors-and-abort',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'AIErrorCode exposes all 14 standardized error code strings.',
    },
  ],
});
