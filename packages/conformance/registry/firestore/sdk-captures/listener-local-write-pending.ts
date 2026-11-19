import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 60,
  featureKeys: ['onSnapshot'],
  api: 'onSnapshot: per-doc metadata.hasPendingWrites on the local-write echo',
  behavior: "Production: the echo of a local write reports `hasPendingWrites` true on the doc, for a doc listener and for the doc inside a query snapshot, and only on the written doc. Pyric reports false on the doc. FL-20.",
  evidence: '`oracle:firestore-listener-local-write-metadata` and `oracle:firestore-query-doc-pending-writes`.',
  risk: ['listener', 'specific-field'],
  riskScore: 3,
  riskReasons: ['asserts listener semantics', 'asserts a specific field/property value'],
  oracleObservations: ['firestore-listener-local-write-metadata', 'firestore-query-doc-pending-writes'],
  conformanceTests: [`${IN_PAGE}/firestore-listener-local-write-metadata.test.ts`, `${IN_PAGE}/firestore-query-doc-pending-writes.test.ts`],
});
