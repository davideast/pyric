import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getHistory"],
  api: 'ChatSession.getHistory()',
  behavior: 'Blocked prompts and blocked candidates are excluded from `getHistory()`',
  status: 'diverged-documented',
  statusNote: 'blocked history',
  automation: 'unit-backed',
  evidence: '`unit:chat-session.test.ts` test `ai#chat-history-excludes-blocked` (upstream JSDoc contract; exercised with a scripted blocked envelope)',
  conformanceTests: ['chat-session.test.ts'],
  notes: 'Pinned delta vs installed 2.12.0: the mirror implements the documented `getHistory()` contract (blocked prompts are not added to history); the installed implementation appends the user turn unconditionally (packages/pyric/src/ai/models.ts).',
});
