import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["functionCall"],
  api: 'functionCall parts',
  behavior: '`functionCall.id` is present on the GoogleAI wire; the mirror emits an id on synthesized calls',
  automation: 'shape-backed',
  evidence: 'Capture ai-function-call-shape (id in functionCallKeySet) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-id-present`',
  oracleObservations: ['ai-function-call-shape'],
  conformanceTests: ['function-calling.test.ts'],
  notes: 'The upstream JSDoc is self-contradictory about backend id support; the capture is the fact.',
});
