import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream()',
  behavior: '`usageMetadata` rides every chunk, not only the last one',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-stream-framing (usageMetadataChunkIndexes covers all chunks) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-usage-every-chunk`',
  oracleObservations: ['ai-generate-stream-framing'],
  conformanceTests: ['streaming.test.ts'],
});
