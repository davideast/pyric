import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["AIError","AIErrorCode"],
  api: 'AIError',
  behavior: 'HTTP failures surface as `AIError` with an `AIErrorCode` code and `customErrorData` carrying `status`, `statusText`, and `errorDetails`',
  automation: 'unit-backed',
  evidence: '`unit:errors-counttokens.test.ts` test `ai#error-aierror-shape` (capture ai-error-bad-api-key cited as the sample envelope)',
  oracleObservations: ['ai-error-bad-api-key'],
  conformanceTests: ['errors-counttokens.test.ts'],
  notes: 'The client-side error class shape wraps the oracle-backed wire envelope.',
});
