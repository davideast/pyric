import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["script"],
  api: 'script(ai, entries)',
  behavior: 'Scripted text is the one place generated text values may be asserted: `response.text()` returns the scripted string exactly',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-text-assertable` (evidence tier ruling 1: generated text is never compared anywhere else)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
