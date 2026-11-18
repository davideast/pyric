import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["sendMessage","getHistory"],
  api: 'ChatSession.sendMessage() / getHistory()',
  behavior: '`sendMessage` appends the user turn and the model turn; `getHistory()` returns the ordered `Content[]` with alternating roles',
  status: 'diverged-documented',
  statusNote: 'clone',
  automation: 'unit-backed',
  evidence: '`unit:chat-session.test.ts` test `ai#chat-history-threads` (no capture; history threading claim)',
  conformanceTests: ['chat-session.test.ts'],
  notes: 'Pinned delta vs installed 2.12.0: `getHistory()` returns a defensive clone so caller mutations never corrupt the session; the installed SDK hands out its live history array (packages/pyric/src/ai/models.ts).',
});
