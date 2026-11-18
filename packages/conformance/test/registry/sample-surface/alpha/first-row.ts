import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getAI'],
  api: 'getAI(target)',
  behavior: 'Returns a bound AI handle',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts`',
  conformanceTests: ['instances.test.ts'],
});
