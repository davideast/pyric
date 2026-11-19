import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 10,
  featureKeys: ['generateContentStream'],
  api: 'generateContentStream()',
  behavior:
    '`result.stream` async-iterates response chunks via `for await`; each chunk is a complete GenerateContentResponse',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-generate-stream-framing` and `ai-sdk-streaming-chunks-and-aggregate` replayed across in-process (`wave2-sdk-oracle.test.ts`, `streaming.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-generate-stream-framing', 'ai-sdk-streaming-chunks-and-aggregate'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'streaming.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-STREAM-ASYNC-ITERABLE',
      observation: 'ai-sdk-streaming-chunks-and-aggregate',
      expect: {
        stream: {
          streamIsAsyncIterable: true,
          chunkCountAtLeastOne: true,
          everyChunkHasTextHelper: true,
          everyChunkHasFunctionCallsHelper: true,
          everyChunkHasCandidatesOrUsage: true,
          everyChunkHasUsageMetadata: true,
          everyChunkCandidateRoleModel: true,
          nonFinalChunksOmitFinishReason: true,
          finalChunkFinishReason: 'STOP',
          finishReasonOnlyOnLastChunk: true,
        },
      },
      probe: PROBE,
      guards: 'generateContentStream yields async-iterable EnhancedGenerateContentResponse chunks with text/functionCalls helpers.',
    },
  ],
});
