import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["script"],
  api: 'script(ai, entries)',
  behavior: 'A `text` shorthand expands to a wire-true envelope: finishReason STOP, usageMetadata with serviceTier, modelVersion, responseId',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-shorthand-text` (capture ai-generate-minimal-envelope cited as the expansion target)',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE + ' One synthesizer owns the shape facts (ruling 3 of the scripted authoring deltas).',
});
