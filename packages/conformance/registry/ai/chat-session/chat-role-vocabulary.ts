import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["POSSIBLE_ROLES"],
  api: 'POSSIBLE_ROLES',
  behavior: '`POSSIBLE_ROLES` is exactly `["user", "model", "function", "system"]`',
  automation: 'unit-backed',
  evidence: '`unit:chat-session.test.ts` test `ai#chat-role-vocabulary` (upstream constant; distinct from the production wire role vocabulary in ai-error-bad-role)',
  conformanceTests: ['chat-session.test.ts'],
});
