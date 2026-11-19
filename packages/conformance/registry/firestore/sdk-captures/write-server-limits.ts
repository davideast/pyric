import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ['setDoc'],
  api: 'setDoc past the documented write limits',
  behavior: 'setDoc fails asynchronously with `invalid-argument` past the server write limits (1 MiB docs, reserved or 1,501-byte ids and field names, 501 transforms, 26 nested maps) while accepting values at the limits across in-page, SharedWorker, and Node-hosted planes, as in production. FW-14.',
  evidence: '`oracle:firestore-write-server-limits` and `oracle:firestore-write-map-depth-limit`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts Firebase error code(s): `invalid-argument`'],
  oracleObservations: ['firestore-write-server-limits', 'firestore-write-map-depth-limit'],
  conformanceTests: [
    `${IN_PAGE}/firestore-write-server-limits.test.ts`,
    `${IN_PAGE}/firestore-write-map-depth-limit.test.ts`,
    `${SERVED}/firestore-write-server-limits.test.ts`,
  ],
});
