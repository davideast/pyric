import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ['runTransaction'],
  api: 'runTransaction when the update function swallows a read-after-write error',
  behavior: 'runTransaction rejects with `invalid-argument` and writes nothing even when the update function catches the read-after-write error and returns, across in-page, SharedWorker, and Node-hosted planes, as in production. FW-6.',
  evidence: '`oracle:firestore-transaction-client-checks` key `swallowedReadAfterWrite`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['atomicity', 'error-code'],
  riskScore: 3,
  riskReasons: ['asserts transaction/batch atomicity', 'asserts Firebase error code(s): `invalid-argument`'],
  oracleObservations: ['firestore-transaction-client-checks'],
  conformanceTests: [
    `${IN_PAGE}/firestore-transaction-client-checks.test.ts`,
    `${SERVED}/firestore-transaction-client-checks.test.ts`,
  ],
});
