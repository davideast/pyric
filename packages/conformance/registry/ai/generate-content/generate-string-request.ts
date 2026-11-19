import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 80,
  featureKeys: ['generateContent'],
  api: 'generateContent(request)',
  behavior: 'A plain string request is wrapped as a single user turn before it reaches the engine',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-sdk-generate-envelope-and-string-request` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-sdk-generate-envelope-and-string-request'],
  conformanceTests: ['generate-helpers-sdk-oracle.test.ts', 'generate-content.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-GENERATE-STRING-REQUEST',
      observation: 'ai-sdk-generate-envelope-and-string-request',
      expect: {
        outboundStringPrompt: {
          contentsLength: 1,
          firstRole: 'user',
          firstPartsLength: 1,
          firstPartTextMatchesPrompt: true,
        },
      },
      probe: PROBE,
      guards:
        'A plain string prompt passed to generateContent normalizes into [{ role: user, parts: [{ text }] }].',
    },
  ],
});
