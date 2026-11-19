import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 120,
  featureKeys: ['serverTimestamp', 'onSnapshot'],
  api: 'serverTimestamp() read from the pending local echo',
  behavior: "Production's pending serverTimestamp echo is pending and reads null, or the estimate or prior value by option; pyric reads a resolved Timestamp. FW-10; also #1355.",
  evidence: '`oracle:firestore-servertimestamp-pending-echo`.',
  risk: ['listener', 'specific-value'],
  riskScore: 3,
  riskReasons: ['asserts listener semantics', 'asserts serverTimestamps option values'],
  oracleObservations: ['firestore-servertimestamp-pending-echo'],
  conformanceTests: [`${IN_PAGE}/firestore-servertimestamp-pending-echo.test.ts`],
});
