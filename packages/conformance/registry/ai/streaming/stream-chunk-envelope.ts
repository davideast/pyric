import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 60,
  featureKeys: ['generateContentStream'],
  api: 'generateContentStream()',
  behavior: 'Every chunk carries `candidates` or `usageMetadata`',
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
      finding: 'AI-STREAM-CHUNK-ENVELOPE',
      observation: 'ai-sdk-streaming-chunks-and-aggregate',
      expect: { model: 'gemini-flash-lite-latest' },
      probe: PROBE,
      guards: 'Every streamed chunk carries candidates or usageMetadata.',
    },
  ],
});
