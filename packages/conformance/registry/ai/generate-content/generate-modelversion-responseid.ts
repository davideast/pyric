import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 70,
  featureKeys: ['generateContent'],
  api: 'generateContent()',
  behavior: '`modelVersion` and `responseId` are present nonempty strings; the sandbox mints them deterministically',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-generate-minimal-envelope` and `ai-sdk-generate-envelope-and-string-request` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: [
    'ai-generate-minimal-envelope',
    'ai-sdk-generate-envelope-and-string-request',
  ],
  conformanceTests: ['generate-helpers-sdk-oracle.test.ts', 'generate-content.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-GENERATE-MODELVERSION-RESPONSEID',
      observation: 'ai-sdk-generate-envelope-and-string-request',
      expect: { httpStatus: 200, wireCallCount: 1 },
      probe: PROBE,
      guards:
        'modelVersion and responseId are present nonempty strings on the response envelope across planes.',
    },
  ],
  notes:
    'Synthesized decoration (ruling 2 in packages/conformance/docs/ai/cdd-deltas.md); the values are minted, only presence and determinism are claims.',
});
