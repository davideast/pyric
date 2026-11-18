import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream()',
  behavior: 'Every chunk carries `candidates` or `usageMetadata`',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-stream-framing (everyEventHasCandidatesOrUsage) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-chunk-envelope`',
  oracleObservations: ['ai-generate-stream-framing'],
  conformanceTests: ['streaming.test.ts'],
});
