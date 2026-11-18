import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream() wire framing',
  behavior: 'Every SSE event is `data: ` prefixed and its payload parses as a complete JSON document',
  automation: 'oracle-backed',
  evidence: 'Capture ai-generate-stream-framing (allEventsDataPrefixed) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test `ai#stream-data-prefixed`',
  oracleObservations: ['ai-generate-stream-framing'],
  conformanceTests: ['streaming.test.ts'],
  notes: 'Byte-compared through the framing encoder the scripting module exports, since the SDK-level stream yields parsed objects.',
});
