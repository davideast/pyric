import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ['onSnapshot'],
  api: 'QueryDocumentSnapshot.metadata.hasPendingWrites on the served planes',
  behavior: 'Only the document with a pending write reports `hasPendingWrites` true, and warmed metadata listeners emit the initial `fromCache: true` snapshot before the server-synced `fromCache: false` snapshot across SharedWorker and Node-hosted planes. FP-5, FL-20, #1355.',
  evidence: '`oracle:firestore-query-doc-pending-writes`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['listener'],
  riskScore: 2,
  riskReasons: ['asserts listener semantics'],
  oracleObservations: ['firestore-query-doc-pending-writes'],
  conformanceTests: [
    `${IN_PAGE}/firestore-query-doc-pending-writes.test.ts`,
    `${SERVED}/firestore-query-doc-pending-writes.test.ts`,
  ],
});
