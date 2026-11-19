import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 110,
  featureKeys: ['generateContent'],
  api: 'generateContent(request)',
  behavior:
    '`responseMimeType` `application/json` plus a `responseSchema` yields a text part that parses as JSON with the schema key set',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-structured-output-shape` and `ai-sdk-structured-system-and-thinking` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: [
    'ai-structured-output-shape',
    'ai-sdk-structured-system-and-thinking',
  ],
  conformanceTests: ['generate-helpers-sdk-oracle.test.ts', 'generate-content.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-GENERATE-STRUCTURED-OUTPUT',
      observation: 'ai-sdk-structured-system-and-thinking',
      expect: { wireCallCount: 3 },
      probe: PROBE,
      guards:
        'responseMimeType application/json with responseSchema produces valid JSON text matching the schema key set.',
    },
  ],
  notes: 'The parsed key set is a shape fact; the JSON values are not claims.',
});
