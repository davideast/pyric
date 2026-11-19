import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['where', 'or'],
  api: "where(field, 'in' | 'not-in' | 'array-contains-any', values) / or(...)",
  behavior: "getDocs fails with `invalid-argument` for `in` with 31 values, `not-in` with 11, `array-contains-any` with 31, or() with 31 branches, and 36 terms after normalization, while 30 and 10 values succeed across in-page, SharedWorker, and Node-hosted planes, as in production. FL-29.",
  evidence: '`oracle:firestore-query-disjunction-limits`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts Firebase error code(s): `invalid-argument`'],
  oracleObservations: ['firestore-query-disjunction-limits'],
  conformanceTests: [
    `${IN_PAGE}/firestore-query-disjunction-limits.test.ts`,
    `${SERVED}/firestore-query-disjunction-limits.test.ts`,
  ],
});
