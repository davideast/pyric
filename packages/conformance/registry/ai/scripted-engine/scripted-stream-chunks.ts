import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["script"],
  api: 'script(ai, entries)',
  behavior: 'A chunk-array shorthand declares chunk boundaries and the engine applies the captured framing, so authors never hand-write SSE',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-stream-chunks` (capture ai-generate-stream-framing cited as the framing source)',
  oracleObservations: ['ai-generate-stream-framing'],
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE + ' Ruling 4 of the scripted authoring deltas.',
});
