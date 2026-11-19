import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 40,
  featureKeys: ['thoughtSummary'],
  api: 'response.thoughtSummary()',
  behavior:
    '`thoughtSummary()` returns undefined when no part is flagged `thought: true`, the captured lite-model case',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-thinking-thought-parts` and `ai-sdk-structured-system-and-thinking` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes, plus `upstream-ai-probes.test.ts` and `helpers-schema.test.ts`.',
  oracleObservations: [
    'ai-thinking-thought-parts',
    'ai-sdk-structured-system-and-thinking',
  ],
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
      finding: 'AI-HELPER-THOUGHTSUMMARY',
      observation: 'ai-sdk-structured-system-and-thinking',
      expect: {
        thinking: {
          httpStatus: 200,
          anyThoughtPart: false,
          anyThoughtSignature: true,
          helperThoughtSummaryIsUndefined: true,
          finishReason: 'STOP',
        },
      },
      probe: PROBE,
      guards:
        'EnhancedGenerateContentResponse.thoughtSummary() returns undefined when no candidate part is flagged thought: true.',
    },
  ],
});
