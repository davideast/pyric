import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["AIErrorCode"],
  api: 'AIErrorCode',
  behavior: '`AIErrorCode` exposes the 14 documented codes, from `error` through `unsupported`',
  automation: 'unit-backed',
  evidence: '`unit:errors-counttokens.test.ts` test `ai#error-code-vocabulary` (upstream constant vocabulary)',
  conformanceTests: ['errors-counttokens.test.ts'],
});
