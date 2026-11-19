import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 20,
  featureKeys: ['generateContent'],
  api: 'generateContent()',
  behavior:
    'The candidate key set is `content`, `finishReason`, `index`, and `index` is present on the wire (0 for the single candidate)',
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
      finding: 'AI-GENERATE-CANDIDATE-KEYS',
      observation: 'ai-sdk-generate-envelope-and-string-request',
      expect: { httpStatus: 200, wireCallCount: 1 },
      probe: PROBE,
      guards:
        'Single-candidate responses carry content, finishReason, and index 0 across in-process and hosted planes.',
    },
  ],
});
