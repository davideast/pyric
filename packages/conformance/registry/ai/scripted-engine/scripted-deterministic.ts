import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["script"],
  api: 'scripted engine',
  behavior: 'The same unscripted request twice yields an identical envelope, candidates and usage included',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-deterministic` (determinism claim from the scripted authoring deltas)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
