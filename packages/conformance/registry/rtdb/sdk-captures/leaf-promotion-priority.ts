import { row, CDD, SERVED } from './section.ts';

export default row({
  order: 100,
  featureKeys: ['set', 'update', 'setWithPriority', 'onDisconnect'],
  api: 'Leaf-to-parent promotion .priority retention across set, update, and onDisconnect',
  behavior: 'When a scalar leaf carrying a numeric or string `.priority` acquires a child via direct `set`/`update`, committed-leaf `onDisconnect` `set`/`update`, or same-session queued `onDisconnect` folding, production and pyric retain the promoted parent `.priority` across rules `newData.getPriority()`, client snapshots, and `exportVal()` on in-page and served planes.',
  evidence: '`oracle:rtdb-modular-leaf-promotion-priority`, replayed in page and on the served worker plane.',
  risk: ['specific-value', 'stateful'],
  riskScore: 2,
  riskReasons: ['asserts priority retention across leaf-to-parent promotion and onDisconnect folding'],
  oracleObservations: ['rtdb-modular-leaf-promotion-priority'],
  conformanceTests: [
    `${CDD}/capture-leaf-promotion-priority.test.ts`,
    `${SERVED}/rtdb-leaf-promotion-priority.test.ts`,
  ],
});
