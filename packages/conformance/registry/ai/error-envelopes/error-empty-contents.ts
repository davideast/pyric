import { ERROR_RISK } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["generateContent", "generateContentStream"],
  api: 'error envelope',
  behavior: 'An empty `contents` array fails 400 INVALID_ARGUMENT with the message `contents is not specified`',
  automation: 'oracle-backed',
  evidence: 'Capture ai-error-empty-contents replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-empty-contents`',
  oracleObservations: ['ai-error-empty-contents'],
  conformanceTests: ['errors-counttokens.test.ts'],
  ...ERROR_RISK,
});
