import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getAI"],
  api: 'getAI(target)',
  behavior: 'With no options the backend defaults to `GoogleAIBackend`, `backendType` is `GOOGLE_AI`, and the AI handle location is the empty string',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#getai-default-backend` (matches upstream AIOptions default)',
  conformanceTests: ['instances.test.ts'],
});
