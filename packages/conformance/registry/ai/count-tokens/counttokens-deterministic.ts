import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["countTokens"],
  api: 'countTokens()',
  behavior: 'An identical payload returns an identical `totalTokens` across calls',
  automation: 'oracle-backed',
  evidence: 'Capture ai-counttokens-envelope (deterministicAcrossTwoCalls) replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#counttokens-deterministic`',
  oracleObservations: ['ai-counttokens-envelope'],
  conformanceTests: ['errors-counttokens.test.ts'],
  notes: 'The sandbox count need not equal the production count; determinism is the claim.',
});
