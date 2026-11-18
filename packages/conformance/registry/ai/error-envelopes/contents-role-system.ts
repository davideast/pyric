import { ERROR_RISK } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["generateContent", "generateContentStream"],
  api: 'error envelope',
  behavior: 'A `contents` turn under role `system` fails 400 INVALID_ARGUMENT with the unknown-role text that lists MODEL, USER, although the role `function` refusal lists SYSTEM',
  automation: 'oracle-backed',
  evidence: 'Capture ai-contents-role-system replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#contents-role-system`',
  oracleObservations: ['ai-contents-role-system'],
  conformanceTests: ['errors-counttokens.test.ts'],
  ...ERROR_RISK,
  notes: 'A top-level `systemInstruction` is the accepted way to send a system prompt (row generate-system-instruction).',
});
