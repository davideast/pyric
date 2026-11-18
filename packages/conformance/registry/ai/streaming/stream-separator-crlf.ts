import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream() wire framing',
  behavior: 'SSE events are separated by CRLF CRLF',
  automation: 'oracle-backed',
  evidence: 'Capture ai-generate-stream-framing (separatorIsCrlfCrlf) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test `ai#stream-separator-crlf`',
  oracleObservations: ['ai-generate-stream-framing'],
  conformanceTests: ['streaming.test.ts'],
  notes: 'Byte-compared through the framing encoder the scripting module exports.',
});
