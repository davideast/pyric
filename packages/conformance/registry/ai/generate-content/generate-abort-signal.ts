import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/chat-errors-abort-oracle.test.ts';

export default row({
  order: 130,
  featureKeys: ['generateContent'],
  api: 'generateContent(request, singleRequestOptions)',
  behavior: 'A pre-aborted `SingleRequestOptions.signal` rejects the call',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-offline-chat-roles-errors-and-abort` replayed across in-process (`chat-errors-abort-oracle.test.ts`), worker-host (`ai-chat-errors-abort.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-offline-chat-roles-errors-and-abort'],
  conformanceTests: ['chat-errors-abort-oracle.test.ts', 'generate-content.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-chat-errors-abort.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-GENERATE-ABORT-SIGNAL',
      observation: 'ai-offline-chat-roles-errors-and-abort',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards:
        'A pre-aborted SingleRequestOptions.signal rejects generateContent with AbortError before issuing outbound network calls.',
    },
  ],
});
