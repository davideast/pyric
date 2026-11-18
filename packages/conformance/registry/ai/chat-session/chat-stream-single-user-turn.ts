import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["sendMessageStream"],
  api: 'ChatSession.sendMessageStream()',
  behavior: 'Exactly one user turn is recorded per `sendMessageStream` call; the mirror implements the 2.13.0 fixed semantics, not the installed 2.12.0 duplicate-user-turn bug',
  status: 'diverged-documented',
  statusNote: '2.13.0 semantics',
  automation: 'unit-backed',
  evidence: '`unit:chat-session.test.ts` test `ai#chat-stream-single-user-turn` (no capture; divergence pinned by ruling, see notes)',
  conformanceTests: ['chat-session.test.ts'],
  notes: 'Ruling 3 in packages/conformance/docs/ai/cdd-deltas.md: the installed 2.12.0 duplicates the user turn, fixed upstream in 2.13.0. Reproducing a known upstream bug harms the developer the sandbox exists for, so the mirror ships the fix (packages/pyric/src/ai/models.ts).',
});
