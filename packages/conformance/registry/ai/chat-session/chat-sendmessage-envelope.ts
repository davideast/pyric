import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["sendMessage"],
  api: 'ChatSession.sendMessage()',
  behavior: 'A `sendMessage` result carries the same envelope facts as `generateContent`: the four top-level keys and role `model`',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/chat-session.test.ts test `ai#chat-sendmessage-envelope`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['chat-session.test.ts'],
});
