import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream()',
  behavior: '`result.stream` async-iterates response chunks via `for await`; each chunk is a complete GenerateContentResponse',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-stream-framing replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-async-iterable`',
  oracleObservations: ['ai-generate-stream-framing'],
  conformanceTests: ['streaming.test.ts'],
});
