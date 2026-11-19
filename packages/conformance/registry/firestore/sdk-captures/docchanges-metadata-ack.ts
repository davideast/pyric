import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ['onSnapshot'],
  api: 'QuerySnapshot.docChanges({ includeMetadataChanges: true }) on the ack snapshot',
  behavior: 'The snapshot that acknowledges a local write lists the doc as `modified` with `hasPendingWrites` false across in-page, SharedWorker, and Node-hosted planes, as in production. FL-21.',
  evidence: '`oracle:firestore-listener-local-write-metadata` key `qMeta`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['listener'],
  riskScore: 2,
  riskReasons: ['asserts listener semantics'],
  oracleObservations: ['firestore-listener-local-write-metadata'],
  conformanceTests: [
    `${IN_PAGE}/firestore-listener-local-write-metadata.test.ts`,
    `${SERVED}/firestore-listener-local-write-metadata.test.ts`,
  ],
});
