import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 110,
  featureKeys: ['runTransaction'],
  api: 'runTransaction error codes',
  behavior: "Production fails read-after-write and update-after-missing-read with `invalid-argument`; pyric gives `failed-precondition` and `not-found`. FW-7.",
  evidence: '`oracle:firestore-transaction-client-checks` keys `readAfterWrite` and `updateAfterReadMissing`.',
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts Firebase error code(s): `invalid-argument`'],
  oracleObservations: ['firestore-transaction-client-checks'],
  conformanceTests: [`${IN_PAGE}/firestore-transaction-client-checks.test.ts`],
});
