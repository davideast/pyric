import { ERROR_RISK } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["generateContent", "generateContentStream"],
  api: 'error envelope',
  behavior: 'An invalid content role fails 400 INVALID_ARGUMENT and the message lists the production role vocabulary: MODEL, USER',
  automation: 'oracle-backed',
  evidence: 'Capture ai-error-bad-role replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-bad-role`',
  oracleObservations: ['ai-error-bad-role'],
  conformanceTests: ['errors-counttokens.test.ts'],
  ...ERROR_RISK,
  notes: 'The 2026-07 capture listed SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER; the 2026-10 capture lists MODEL, USER (#1410). Production still accepts role `assistant` and refuses role `system` with this text (rows contents-role-assistant, contents-role-system), and the broker does the same. Role `function` gets its own refusal (row fncall-function-role-refused).',
});
