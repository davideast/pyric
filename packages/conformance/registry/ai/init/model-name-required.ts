import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["getGenerativeModel"],
  api: 'getGenerativeModel(ai, modelParams)',
  behavior: '`getGenerativeModel` without `modelParams.model` throws an `AIError` with code `no-model`',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#model-name-required` (upstream throw contract)',
  conformanceTests: ['instances.test.ts'],
});
