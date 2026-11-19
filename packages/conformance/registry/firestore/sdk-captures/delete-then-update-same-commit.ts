import { IN_PAGE, row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ['writeBatch', 'runTransaction'],
  api: 'writeBatch / runTransaction: delete then update of one doc',
  behavior: 'A batch or transaction that deletes and then updates one doc fails with `invalid-argument` and leaves the doc unchanged, as production does. Set then update and update then delete commit. Only the error text differs. The capture refuted hunt finding FW-19.',
  evidence: '`oracle:firestore-delete-then-update-same-commit`.',
  risk: ['error-code', 'atomicity'],
  riskScore: 3,
  riskReasons: ['asserts Firebase error code(s): `invalid-argument`', 'asserts transaction/batch atomicity'],
  oracleObservations: ['firestore-delete-then-update-same-commit'],
  conformanceTests: [`${IN_PAGE}/firestore-delete-then-update-same-commit.test.ts`],
});
