import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["generateContent"],
  api: 'generateContent(request)',
  behavior: 'A `contents` turn under role `assistant` is accepted (200, finishReason STOP), although the unknown-role text lists only MODEL, USER',
  automation: 'oracle-backed',
  evidence: 'Capture ai-contents-role-assistant replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#contents-role-assistant`',
  oracleObservations: ['ai-contents-role-assistant'],
  conformanceTests: ['generate-content.test.ts'],
  notes: 'The probe sent one prior answer under role assistant between two user turns, with no tools. Whether production treats an assistant turn as a model turn for thought-signature checks is not captured.',
});
