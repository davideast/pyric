import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["getGenerativeModel"],
  api: 'getGenerativeModel(ai, modelParams)',
  behavior: 'A short model name such as `gemini-flash-lite-latest` normalizes to the `models/` resource name on `GenerativeModel.model`',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#model-name-short` (upstream AIModel normalization on the GoogleAI backend)',
  conformanceTests: ['instances.test.ts'],
});
