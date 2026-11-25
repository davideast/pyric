import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/init-backends-oracle.test.ts';

export default row({
  order: 30,
  featureKeys: ['getAI'],
  api: 'getAI(target)',
  behavior:
    'With no options the backend defaults to `GoogleAIBackend` and `backendType` is `GOOGLE_AI`',
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
      finding: 'AI-GETAI-DEFAULT-BACKEND',
      observation: 'ai-offline-init-backends-and-model-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'Default getAI(app) constructs a GoogleAIBackend handle with backendType GOOGLE_AI.',
    },
  ],
});
