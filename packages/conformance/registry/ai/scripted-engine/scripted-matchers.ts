import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["script"],
  api: 'script(ai, entries)',
  behavior: 'Entries match by substring, regex, or predicate on the request; a matching entry wins over the plain queue',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-matchers` (ruling 2 of the scripted authoring deltas)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
