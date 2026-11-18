import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["getAI"],
  api: 'getAI(sandbox)',
  behavior: 'The sandbox target with the scripted engine performs no network I/O for generateContent',
  automation: 'sandbox-only',
  evidence: '`unit:instances.test.ts` test `ai#getai-sandbox-no-network` (ruling 1 of the engine placement deltas: the scripted engine does no I/O anywhere)',
  conformanceTests: ['instances.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
