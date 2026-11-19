import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 130,
  featureKeys: ['disableNetwork', 'setDoc'],
  api: 'setDoc that the rules deny, made while the network is disabled',
  behavior: 'Production keeps a denied offline write pending with a local event, then rejects after reconnect; pyric rejects at once. FW-17.',
  evidence: '`oracle:firestore-offline-denied-write`.',
  risk: ['rules-denial', 'listener'],
  riskScore: 3,
  riskReasons: ['asserts rules-denial timing', 'asserts listener semantics'],
  oracleObservations: ['firestore-offline-denied-write'],
  conformanceTests: [`${IN_PAGE}/firestore-offline-denied-write.test.ts`],
});
