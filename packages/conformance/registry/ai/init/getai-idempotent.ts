import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["getAI"],
  api: 'getAI(target)',
  behavior: 'Repeat `getAI` calls with the same target return a stable handle',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#getai-idempotent` (no capture; structural claim)',
  conformanceTests: ['instances.test.ts'],
});
