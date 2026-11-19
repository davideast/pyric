import { IN_PAGE, SERVED, captureRow } from './section.ts';

export default captureRow({
  order: 140,
  featureKeys: ['getDoc', 'setDoc'],
  api: 'NaN, Infinity, -Infinity and -0 on the served planes',
  behavior: 'Production keeps NaN, Infinity, -Infinity and -0 on a server read, and `== NaN` matches only the NaN doc. The in-page sandbox agrees. On the SharedWorker and Node host planes they read back as null and 0. FP-1.',
  evidence: '`oracle:firestore-non-finite-number-roundtrip`.',
  risk: ['specific-value'],
  riskScore: 3,
  riskReasons: ['asserts stored values survive the worker protocol'],
  oracleObservations: ['firestore-non-finite-number-roundtrip'],
  conformanceTests: [`${SERVED}/firestore-non-finite-number-roundtrip.test.ts`, `${IN_PAGE}/firestore-non-finite-number-roundtrip.test.ts`],
});
