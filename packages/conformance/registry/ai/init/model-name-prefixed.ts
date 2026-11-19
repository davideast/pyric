import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/init-backends-oracle.test.ts';

export default row({
  order: 80,
  featureKeys: ['getGenerativeModel'],
  api: 'getGenerativeModel(ai, modelParams)',
  behavior: 'A `models/`-prefixed name is accepted without double prefixing',
  status: 'diverged-documented',
  statusNote: 'normalization',
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
      finding: 'AI-MODEL-NAME-PREFIXED',
      observation: 'ai-offline-init-backends-and-model-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'GoogleAIBackend accepts models/<name> without upstream models/models/<name> double-prefixing.',
    },
  ],
  notes:
    'Pinned delta vs installed 2.12.0 and 2.16.0 (`firebase` 12.19.0): upstream `AIModel.normalizeGoogleAIModelName` double-prefixes an already `models/`-prefixed name, whereas the mirror normalizes to a single `models/` prefix (`packages/pyric/src/ai/models.ts`).',
});
