import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["functionCall"],
  api: 'scripted engine synthesis',
  behavior: 'The engine mints a `thoughtSignature` on every functionCall part it synthesizes, so scripted tool round trips replay cleanly',
  automation: 'sandbox-only',
  evidence: '`unit:function-calling.test.ts` test `ai#fncall-signature-minted` (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection)',
  oracleObservations: ['ai-error-fncall-missing-thought-signature'],
  conformanceTests: ['function-calling.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE + ' Ruling 3 of the scripted authoring deltas names this mint.',
});
