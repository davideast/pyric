import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["functionCall"],
  api: 'functionResponse round trip',
  behavior: 'A round trip that threads the model functionCall turn back verbatim, thoughtSignature preserved, is accepted: the answer has a text part and no further functionCall part',
  automation: 'shape-backed',
  evidence: 'Capture ai-function-response-round replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-round-trip`',
  oracleObservations: ['ai-function-response-round'],
  conformanceTests: ['function-calling.test.ts'],
});
