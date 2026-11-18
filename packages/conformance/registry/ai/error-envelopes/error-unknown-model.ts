import { ERROR_RISK } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["generateContent", "generateContentStream", "countTokens"],
  api: 'error envelope',
  behavior: 'A model name production has never served fails 404 NOT_FOUND with the error key set `code`, `message`, `status` and no details',
  automation: 'oracle-backed',
  evidence: 'Capture ai-error-unknown-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-unknown-model`',
  oracleObservations: ['ai-error-unknown-model'],
  conformanceTests: ['errors-counttokens.test.ts'],
  ...ERROR_RISK,
});
