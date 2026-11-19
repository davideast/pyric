import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ['getDoc', 'setDoc'],
  api: 'NaN, Infinity, -Infinity and -0 on the served planes',
  behavior: 'NaN, Infinity, -Infinity and -0 round-trip intact on a server read, and `== NaN` matches only the NaN doc across in-page, SharedWorker, and Node-hosted planes, as in production. FP-1.',
  evidence: '`oracle:firestore-non-finite-number-roundtrip`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['specific-value'],
  riskScore: 3,
  riskReasons: ['asserts stored values survive the worker protocol'],
  oracleObservations: ['firestore-non-finite-number-roundtrip'],
  conformanceTests: [`${SERVED}/firestore-non-finite-number-roundtrip.test.ts`, `${IN_PAGE}/firestore-non-finite-number-roundtrip.test.ts`],
});
