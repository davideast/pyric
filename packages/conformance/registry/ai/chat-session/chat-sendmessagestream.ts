import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["sendMessageStream"],
  api: 'ChatSession.sendMessageStream()',
  behavior: '`sendMessageStream` returns a stream plus a response promise; history updates after aggregation completes',
  automation: 'unit-backed',
  evidence: '`unit:chat-session.test.ts` test `ai#chat-sendmessagestream` (no capture; streaming turn claim)',
  conformanceTests: ['chat-session.test.ts'],
});
