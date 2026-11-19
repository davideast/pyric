import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/init-backends-oracle.test.ts';

export default row({
  order: 20,
  featureKeys: ['getAI'],
  api: 'getAI(target)',
  behavior:
    "After package resolution selects the mirror, `getAI(app)` uses the app's sandbox and the returned handle carries the app",
  automation: 'oracle-backed',
  risk: ['structural'],
  riskReasons: ['structural / routing-only claim'],
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
      finding: 'AI-GETAI-APP-DISPATCH',
      observation: 'ai-offline-init-backends-and-model-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'getAI(app) carries ai.app === app and isolates handles across distinct FirebaseApp instances.',
    },
  ],
  notes: 'Production code keeps resolving firebase/ai; the pyric/ai module contains no production dispatch.',
});
