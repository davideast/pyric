import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["text"],
  api: 'response.text()',
  behavior: '`text()` throws on bad finish reasons such as `SAFETY` and on a blocked prompt',
  automation: 'unit-backed',
  evidence: '`unit:helpers-schema.test.ts` test `ai#helper-text-throws` (exercised with a scripted SAFETY envelope)',
  conformanceTests: ['helpers-schema.test.ts'],
});
