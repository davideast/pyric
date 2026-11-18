import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getAI"],
  api: 'getAI(target)',
  behavior: '`getAI(sandbox)` returns an AI handle bound to the sandbox target; a model minted from it answers through the in-process answer engine',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#getai-sandbox-dispatch` (no capture; structural dispatch claim)',
  conformanceTests: ['instances.test.ts'],
});
