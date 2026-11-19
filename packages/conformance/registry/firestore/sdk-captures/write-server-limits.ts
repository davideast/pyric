import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 80,
  featureKeys: ['setDoc'],
  api: 'setDoc past the documented write limits',
  behavior: 'Production fails with `invalid-argument` past its write limits (1 MiB docs, reserved or 1,501-byte ids and field names, 501 transforms, 26 nested maps); pyric stores them. FW-14.',
  evidence: '`oracle:firestore-write-server-limits` and `oracle:firestore-write-map-depth-limit`.',
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts Firebase error code(s): `invalid-argument`'],
  oracleObservations: ['firestore-write-server-limits', 'firestore-write-map-depth-limit'],
  conformanceTests: [`${IN_PAGE}/firestore-write-server-limits.test.ts`, `${IN_PAGE}/firestore-write-map-depth-limit.test.ts`],
});
