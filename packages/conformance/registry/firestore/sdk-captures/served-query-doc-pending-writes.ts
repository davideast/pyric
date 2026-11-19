import { SERVED, captureRow } from './section.ts';

export default captureRow({
  order: 150,
  featureKeys: ['onSnapshot'],
  api: 'QueryDocumentSnapshot.metadata.hasPendingWrites on the served planes',
  behavior: "Production: only the doc with a pending write reports `hasPendingWrites` true. The served planes report each doc's own value from the in-page engine, which reports false on the written doc (FL-20), and they skip the first snapshot from the cache (#1355). FP-5 is fixed.",
  evidence: '`oracle:firestore-query-doc-pending-writes`.',
  risk: ['listener'],
  riskScore: 2,
  riskReasons: ['asserts listener semantics'],
  oracleObservations: ['firestore-query-doc-pending-writes'],
  conformanceTests: [`${SERVED}/firestore-query-doc-pending-writes.test.ts`],
});
