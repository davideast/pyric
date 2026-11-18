import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["inlineDataParts"],
  api: 'response.inlineDataParts()',
  behavior: '`inlineDataParts()` returns the `InlineDataPart` array when inlineData parts exist and undefined when none do',
  automation: 'unit-backed',
  evidence: '`unit:helpers-schema.test.ts` test `ai#helper-inlinedataparts` (exercised with a scripted raw envelope)',
  conformanceTests: ['helpers-schema.test.ts'],
});
