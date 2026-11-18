import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["countTokens"],
  api: 'countTokens()',
  behavior: 'The countTokens envelope key set is exactly `promptTokensDetails`, `totalTokens`',
  automation: 'oracle-backed',
  evidence: 'Capture ai-counttokens-envelope replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#counttokens-envelope`',
  oracleObservations: ['ai-counttokens-envelope'],
  conformanceTests: ['errors-counttokens.test.ts'],
});
