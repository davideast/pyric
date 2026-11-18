import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["script"],
  api: 'scripted engine',
  behavior: 'With no script the engine returns a deterministic synthesized response derived from the request, wire-true in shape: the captured envelope key sets hold',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-zero-config` (capture ai-generate-minimal-envelope cited as the shape source)',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE + ' Ruling 1 of the scripted authoring deltas: tests and demos never hang on missing setup.',
});
