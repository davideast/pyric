import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["generateContentStream"],
  api: 'generateContentStream()',
  behavior: '`result.response` resolves to an aggregated response whose text is the concatenation of the streamed text parts',
  automation: 'unit-backed',
  evidence: '`unit:streaming.test.ts` test `ai#stream-response-aggregate` (aggregation semantics; text values come from an explicit script)',
  conformanceTests: ['streaming.test.ts'],
  notes: 'Text equality is only asserted because the scripted engine was explicitly scripted to return it.',
});
