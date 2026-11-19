import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 80,
  featureKeys: ['generateContentStream'],
  api: 'generateContentStream()',
  behavior: 'The aggregated response carries the final chunk `finishReason` and `usageMetadata`',
  status: 'diverged-documented',
  statusNote: 'metadata carry',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-sdk-streaming-chunks-and-aggregate` (`aggregate.hasUsageMetadata: false`, `hasModelVersion: false`, `hasResponseId: false`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `streaming.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-sdk-streaming-chunks-and-aggregate'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'streaming.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-STREAM-AGGREGATE-FINAL-META',
      observation: 'ai-sdk-streaming-chunks-and-aggregate',
      expect: { model: 'gemini-flash-lite-latest' },
      probe: PROBE,
      guards: 'Aggregated stream response carries final finishReason and preserves terminal usageMetadata, modelVersion, and responseId.',
    },
  ],
  notes:
    'Pinned delta vs installed 2.12.0 and 2.16.0 (`firebase` 12.19.0): upstream `aggregateResponses` drops the final chunk `usageMetadata`, `modelVersion`, and `responseId` on the aggregate (`ai-sdk-streaming-chunks-and-aggregate`), whereas the mirror carries them along (`packages/pyric/src/ai/response-helpers.ts`).',
});
