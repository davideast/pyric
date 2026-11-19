import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 50,
  featureKeys: ['Schema'],
  api: 'generationConfig.responseSchema',
  behavior:
    'A built `Schema` serializes into `generationConfig.responseSchema` on the request and drives JSON output',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-structured-output-shape` and `ai-sdk-structured-system-and-thinking` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: [
    'ai-structured-output-shape',
    'ai-sdk-structured-system-and-thinking',
  ],
  conformanceTests: ['generate-helpers-sdk-oracle.test.ts', 'helpers-schema.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-SCHEMA-RIDES-REQUEST',
      observation: 'ai-sdk-structured-system-and-thinking',
      expect: { wireCallCount: 3 },
      probe: PROBE,
      guards:
        'Schema.object serializes via toJSON onto generationConfig.responseSchema before crossing in-process or worker boundaries.',
    },
  ],
});
