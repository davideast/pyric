import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["functionCall"],
  api: 'functionResponse round trip',
  behavior: 'A replayed model functionCall turn lacking `thoughtSignature` is rejected 400 INVALID_ARGUMENT with the thought-signature message',
  automation: 'oracle-backed',
  evidence: 'Capture ai-error-fncall-missing-thought-signature replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-thought-signature-required`',
  oracleObservations: ['ai-error-fncall-missing-thought-signature'],
  conformanceTests: ['function-calling.test.ts'],
  risk: ['error-code', 'specific-value'],
  riskScore: 2,
  riskReasons: ['asserts production error status and message text that can drift on re-capture'],
  notes: 'No SDK typing or reference doc states this requirement; the capture is the only evidence.',
});
