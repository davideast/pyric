import { ERROR_RISK } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["generateContent", "generateContentStream", "countTokens"],
  api: 'error envelope',
  behavior: 'A retired model family (Gemini 1.5) fails 404 NOT_FOUND with an ErrorInfo detail and a retirement message distinct from unknown-model',
  automation: 'oracle-backed',
  evidence: 'Capture ai-error-retired-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-retired-model`',
  oracleObservations: ['ai-error-retired-model'],
  conformanceTests: ['errors-counttokens.test.ts'],
  ...ERROR_RISK,
  notes: 'Production distinguishes never-existed from retired; the mirror does too.',
});
