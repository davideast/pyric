import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["text"],
  api: 'response helpers',
  behavior: 'Helpers tolerate omitted decoration: an envelope without `usageMetadata`, `finishReason`, or `safetyRatings` still serves `text()` without throwing',
  automation: 'unit-backed',
  evidence: '`unit:helpers-schema.test.ts` test `ai#helper-tolerates-missing-decor` (exercised with a scripted bare envelope)',
  conformanceTests: ['helpers-schema.test.ts'],
});
