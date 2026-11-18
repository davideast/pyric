import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["text"],
  api: 'response.text()',
  behavior: '`text()` concatenates the text parts of the first candidate',
  automation: 'unit-backed',
  evidence: '`unit:upstream-ai-probes.test.ts` (I3 text() across mixed parts) + `unit:helpers-schema.test.ts` test `ai#helper-text`',
  conformanceTests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
});
