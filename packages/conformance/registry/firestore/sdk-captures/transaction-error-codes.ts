import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ['runTransaction'],
  api: 'runTransaction error codes',
  behavior: 'runTransaction fails read-after-write and update-after-missing-read with `invalid-argument` across in-page, SharedWorker, and Node-hosted planes, as in production. FW-7.',
  evidence: '`oracle:firestore-transaction-client-checks` keys `readAfterWrite` and `updateAfterReadMissing`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts Firebase error code(s): `invalid-argument`'],
  oracleObservations: ['firestore-transaction-client-checks'],
  conformanceTests: [
    `${IN_PAGE}/firestore-transaction-client-checks.test.ts`,
    `${SERVED}/firestore-transaction-client-checks.test.ts`,
  ],
});
