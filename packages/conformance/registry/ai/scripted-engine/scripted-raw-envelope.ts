import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["script"],
  api: 'script(ai, entries)',
  behavior: 'A raw Gemini envelope entry is returned verbatim, so an observation `behavior.raw` pastes in directly and captures are the corpus',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-raw-envelope` (ruling 3 of the scripted authoring deltas)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
