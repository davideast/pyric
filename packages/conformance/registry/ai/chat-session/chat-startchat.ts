import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["startChat"],
  api: 'GenerativeModel.startChat()',
  behavior: '`startChat` returns a `ChatSession` seeded with `StartChatParams.history`',
  automation: 'unit-backed',
  evidence: '`unit:upstream-ai-probes.test.ts` (I1 validateChatHistory accept/reject via startChat) + `unit:chat-session.test.ts` test `ai#chat-startchat`',
  conformanceTests: ['upstream-ai-probes.test.ts', 'chat-session.test.ts'],
});
