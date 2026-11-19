import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ['serverTimestamp', 'onSnapshot'],
  api: 'serverTimestamp() read from the pending local echo',
  behavior: 'A pending `serverTimestamp()` local echo reports `hasPendingWrites` true and reads `null` by default (`none`), a `Timestamp` under `estimate`, and the prior field value under `previous` across in-page, SharedWorker, and Node-hosted planes. FW-10, #1355.',
  evidence: '`oracle:firestore-servertimestamp-pending-echo`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['listener', 'specific-value'],
  riskScore: 3,
  riskReasons: ['asserts listener semantics', 'asserts serverTimestamps option values'],
  oracleObservations: ['firestore-servertimestamp-pending-echo'],
  conformanceTests: [
    `${IN_PAGE}/firestore-servertimestamp-pending-echo.test.ts`,
    `${SERVED}/firestore-servertimestamp-pending-echo.test.ts`,
  ],
});
