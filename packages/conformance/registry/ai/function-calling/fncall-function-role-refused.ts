import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["functionCall"],
  api: 'functionResponse round trip',
  behavior: 'A function response under role `function`, the role the SDK `ChatSession` sends, is refused 400 INVALID_ARGUMENT with a message that names the role; the same round trip under role `user` is accepted',
  automation: 'oracle-backed',
  evidence: 'Capture ai-error-function-role-refused replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-function-role-refused`',
  oracleObservations: ['ai-error-function-role-refused'],
  conformanceTests: ['function-calling.test.ts'],
  risk: ['error-code', 'specific-value'],
  riskScore: 2,
  riskReasons: ['asserts production error status and message text that can drift on re-capture'],
  notes: 'Production started refusing role `function` by 2026-10 (#1410); the 2026-07 captures sent it and were accepted. @firebase/ai 2.12.0 still sends it, so a real SDK chat with tools fails in production and in the sandbox alike.',
});
