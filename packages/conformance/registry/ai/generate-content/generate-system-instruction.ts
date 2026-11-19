import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 90,
  featureKeys: ['generateContent'],
  api: 'generateContent(request)',
  behavior: 'A top-level `systemInstruction` is accepted and the response envelope shape is unaffected',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-system-instruction-accepted` and `ai-sdk-structured-system-and-thinking` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: [
    'ai-system-instruction-accepted',
    'ai-sdk-structured-system-and-thinking',
  ],
  conformanceTests: ['generate-helpers-sdk-oracle.test.ts', 'generate-content.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-GENERATE-SYSTEM-INSTRUCTION',
      observation: 'ai-sdk-structured-system-and-thinking',
      expect: {
        systemInstruction: {
          httpStatus: 200,
          outboundRole: 'system',
          outboundPartsLength: 1,
          outboundTextMatchesInput: true,
          wireTopLevelKeySet: ['candidates', 'modelVersion', 'responseId', 'usageMetadata'],
          finishReason: 'STOP',
        },
      },
      probe: PROBE,
      guards:
        'Top-level systemInstruction normalizes to role system and preserves the standard four-key response envelope.',
    },
  ],
});
