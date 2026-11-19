import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ['disableNetwork', 'setDoc'],
  api: 'setDoc that the rules deny, made while the network is disabled',
  behavior: 'A rules-denied write issued after `disableNetwork` stays pending with a local cached snapshot and rejects with `permission-denied` upon `enableNetwork` across in-page, SharedWorker, and Node-hosted planes. FW-17.',
  evidence: '`oracle:firestore-offline-denied-write`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['rules-denial', 'listener'],
  riskScore: 3,
  riskReasons: ['asserts rules-denial timing', 'asserts listener semantics'],
  oracleObservations: ['firestore-offline-denied-write'],
  conformanceTests: [
    `${IN_PAGE}/firestore-offline-denied-write.test.ts`,
    `${SERVED}/firestore-offline-denied-write.test.ts`,
  ],
});
