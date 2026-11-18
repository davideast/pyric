import { ERROR_RISK } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["generateContent", "generateContentStream", "countTokens"],
  api: 'error envelope',
  behavior: 'An invalid API key fails 400 INVALID_ARGUMENT, not 401, with ErrorInfo plus LocalizedMessage details and the message `API key not valid. Please pass a valid API key.`',
  automation: 'oracle-backed',
  evidence: 'Capture ai-error-bad-api-key replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-bad-api-key`',
  oracleObservations: ['ai-error-bad-api-key'],
  conformanceTests: ['errors-counttokens.test.ts'],
  ...ERROR_RISK,
  notes: 'detailTypes is a set; the messaging effort found details ordering is not stable.',
});
