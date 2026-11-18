import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["script"],
  api: 'script(ai, entries)',
  behavior: 'Script entries without matchers are consumed in FIFO queue order',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-queue-order` (ruling 2 of the scripted authoring deltas)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
