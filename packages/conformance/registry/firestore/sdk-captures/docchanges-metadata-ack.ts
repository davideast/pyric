import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 70,
  featureKeys: ['onSnapshot'],
  api: 'QuerySnapshot.docChanges({ includeMetadataChanges: true }) on the ack snapshot',
  behavior: "Production: the snapshot that acknowledges a local write lists the doc as `modified` with `hasPendingWrites` false. Pyric's list is empty. FL-21.",
  evidence: '`oracle:firestore-listener-local-write-metadata` key `qMeta`.',
  risk: ['listener'],
  riskScore: 2,
  riskReasons: ['asserts listener semantics'],
  oracleObservations: ['firestore-listener-local-write-metadata'],
  conformanceTests: [`${IN_PAGE}/firestore-listener-local-write-metadata.test.ts`],
});
