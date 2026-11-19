import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 10,
  featureKeys: ['text'],
  api: 'response.text()',
  behavior: '`text()` concatenates the text parts of the first candidate',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-sdk-generate-envelope-and-string-request` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes, plus `upstream-ai-probes.test.ts` and `helpers-schema.test.ts`.',
  oracleObservations: ['ai-sdk-generate-envelope-and-string-request'],
  conformanceTests: [
    'generate-helpers-sdk-oracle.test.ts',
    'upstream-ai-probes.test.ts',
    'helpers-schema.test.ts',
  ],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-HELPER-TEXT',
      observation: 'ai-sdk-generate-envelope-and-string-request',
      expect: {
        enhancedResponse: {
          candidateIndex: 0,
          finishReason: 'STOP',
          usageServiceTierPresent: true,
          helperTextIsNonEmptyString: true,
          helperTextMatchesConcatenatedNonThoughtParts: true,
          helperInlineDataPartsIsUndefined: true,
          helperFunctionCallsIsUndefined: true,
        },
      },
      probe: PROBE,
      guards:
        'EnhancedGenerateContentResponse.text() concatenates non-thought text parts of candidate 0 across planes.',
    },
  ],
});
