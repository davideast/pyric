import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/init-backends-oracle.test.ts';

export default row({
  order: 60,
  featureKeys: [],
  queryable: false,
  api: 'VertexAIBackend (removed in @firebase/ai 3.1.0)',
  behavior:
    'Historical record: `VertexAIBackend`, `BackendType.VERTEX_AI`, and `AI.location` were removed in `@firebase/ai` 3.1.0 (`firebase` 13.4.0); neither `firebase/ai` nor `pyric/ai` exports `VertexAIBackend` at runtime',
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
      guards: 'VertexAIBackend, BackendType.VERTEX_AI, and AI.location remain absent after @firebase/ai 3.1.0 removal.',
    },
  ],
});
