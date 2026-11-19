import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 70,
  featureKeys: ['generateContentStream'],
  api: 'generateContentStream()',
  behavior:
    '`result.response` resolves to an aggregated response whose text is the concatenation of the streamed text parts',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-sdk-streaming-chunks-and-aggregate` (`aggregateTextMatchesConcatenatedChunks: true`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `streaming.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-sdk-streaming-chunks-and-aggregate'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'streaming.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-STREAM-RESPONSE-AGGREGATE',
      observation: 'ai-sdk-streaming-chunks-and-aggregate',
      expect: {
        aggregate: {
          hasTextHelper: true,
          aggregateTextNonEmpty: true,
          aggregateTextMatchesConcatenatedChunks: true,
          candidateRole: 'model',
          finishReason: 'STOP',
          hasUsageMetadata: false,
          hasModelVersion: false,
          hasResponseId: false,
          inferenceSource: 'in_cloud',
        },
      },
      probe: PROBE,
      guards: 'result.response resolves to an aggregated response whose text() equals the concatenation of streamed chunk texts.',
    },
  ],
});
