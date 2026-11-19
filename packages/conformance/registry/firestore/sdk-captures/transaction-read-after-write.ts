import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 100,
  featureKeys: ['runTransaction'],
  api: 'runTransaction when the update function swallows a read-after-write error',
  behavior: 'Production: runTransaction rejects `invalid-argument` and writes nothing, even when the update function catches the read-after-write error and returns. Pyric resolves with the returned value and commits the write. FW-6.',
  evidence: '`oracle:firestore-transaction-client-checks` key `swallowedReadAfterWrite`.',
  risk: ['atomicity', 'error-code'],
  riskScore: 3,
  riskReasons: ['asserts transaction/batch atomicity', 'asserts Firebase error code(s): `invalid-argument`'],
  oracleObservations: ['firestore-transaction-client-checks'],
  conformanceTests: [`${IN_PAGE}/firestore-transaction-client-checks.test.ts`],
});
