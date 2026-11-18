import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream()',
  behavior: '`finishReason` appears only on the last chunk of a stream',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-stream-framing (finishReasonOnlyOnLastChunk) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-finish-last-chunk`',
  oracleObservations: ['ai-generate-stream-framing'],
  conformanceTests: ['streaming.test.ts'],
});
