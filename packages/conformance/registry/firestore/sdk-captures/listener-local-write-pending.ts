import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ['onSnapshot'],
  api: 'onSnapshot: per-doc metadata.hasPendingWrites on the local-write echo',
  behavior: 'The echo of a local write reports `hasPendingWrites` true on the written doc for both document and query listeners (and false on sibling docs), with warmed metadata listeners delivering `fromCache: true` then `fromCache: false` across in-page, SharedWorker, and Node-hosted planes. FL-20, #1355.',
  evidence: '`oracle:firestore-listener-local-write-metadata` and `oracle:firestore-query-doc-pending-writes`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['listener', 'specific-field'],
  riskScore: 3,
  riskReasons: ['asserts listener semantics', 'asserts a specific field/property value'],
  oracleObservations: ['firestore-listener-local-write-metadata', 'firestore-query-doc-pending-writes'],
  conformanceTests: [
    `${IN_PAGE}/firestore-listener-local-write-metadata.test.ts`,
    `${IN_PAGE}/firestore-query-doc-pending-writes.test.ts`,
    `${SERVED}/firestore-listener-local-write-metadata.test.ts`,
    `${SERVED}/firestore-query-doc-pending-writes.test.ts`,
  ],
});
