import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 120,
  featureKeys: ['generateContent'],
  api: 'generateContent(request)',
  behavior:
    'With `thinkingConfig` on the probe model, text parts carry `thoughtSignature` and no part is flagged `thought: true`',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-thinking-thought-parts` and `ai-sdk-structured-system-and-thinking` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: [
    'ai-thinking-thought-parts',
    'ai-sdk-structured-system-and-thinking',
  ],
  conformanceTests: ['generate-helpers-sdk-oracle.test.ts', 'generate-content.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-GENERATE-THINKING-SIGNATURE',
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
        'Lite-model responses under thinkingConfig carry thoughtSignature without flagging text parts as thought: true.',
    },
  ],
  notes: 'Lite models return signatures without thought parts; that is the captured fact.',
});
