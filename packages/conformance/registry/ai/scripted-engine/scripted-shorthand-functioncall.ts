import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["script"],
  api: 'script(ai, entries)',
  behavior: 'A `functionCall` shorthand expands to a model turn whose functionCall part carries a minted `thoughtSignature`',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#scripted-shorthand-functioncall` (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection)',
  oracleObservations: ['ai-error-fncall-missing-thought-signature'],
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
