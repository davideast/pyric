import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/init-backends-oracle.test.ts';

export default row({
  order: 40,
  featureKeys: ['getAI'],
  api: 'getAI(target)',
  behavior: 'Repeat `getAI` calls with the same target return a stable handle',
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
      finding: 'AI-GETAI-IDEMPOTENT',
      observation: 'ai-offline-init-backends-and-model-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'Repeat getAI calls share handles per (app, backend, location) while separating GoogleAI, VertexAI locations, and distinct apps.',
    },
  ],
});
