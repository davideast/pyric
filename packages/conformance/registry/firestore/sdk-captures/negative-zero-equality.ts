import { IN_PAGE, row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['where'],
  api: "where(field, '==' | '!=', 0) with a -0 value stored",
  behavior: '-0 equals 0 in `==` and `!=` but not in `in`, as in production. FL-31.',
  evidence: '`oracle:firestore-query-negative-zero` and `oracle:firestore-non-finite-number-roundtrip` key `eq0`.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts query membership'],
  oracleObservations: ['firestore-query-negative-zero', 'firestore-non-finite-number-roundtrip'],
  conformanceTests: [`${IN_PAGE}/firestore-query-negative-zero.test.ts`, `${IN_PAGE}/firestore-non-finite-number-roundtrip.test.ts`],
});
