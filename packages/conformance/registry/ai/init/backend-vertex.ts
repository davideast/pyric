import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/init-backends-oracle.test.ts';

export default row({
  order: 60,
  featureKeys: ['VertexAIBackend'],
  api: 'VertexAIBackend',
  behavior:
    '`VertexAIBackend` carries `backendType` `VERTEX_AI`; its location and the resulting AI handle location default to `us-central1`',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-offline-init-backends-and-model-guards` replayed across in-process (`init-backends-oracle.test.ts`), worker-host (`ai-init-backends.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-offline-init-backends-and-model-guards'],
  conformanceTests: ['init-backends-oracle.test.ts', 'instances.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-init-backends.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-BACKEND-VERTEX',
      observation: 'ai-offline-init-backends-and-model-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'VertexAIBackend defaults location to us-central1 and propagates custom regions onto the AI handle.',
    },
  ],
});
