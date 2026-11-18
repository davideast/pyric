import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream()',
  behavior: 'The aggregated response carries the final chunk `finishReason` and `usageMetadata`',
  status: 'diverged-documented',
  statusNote: 'metadata carry',
  automation: 'unit-backed',
  evidence: '`unit:streaming.test.ts` test `ai#stream-aggregate-final-meta` (aggregation semantics derived from the framing capture)',
  conformanceTests: ['streaming.test.ts'],
  notes: 'Pinned delta vs installed 2.12.0: upstream aggregateResponses drops the final chunk usageMetadata, modelVersion, and responseId on the aggregate; the mirror carries them along (packages/pyric/src/ai/response-helpers.ts).',
});
