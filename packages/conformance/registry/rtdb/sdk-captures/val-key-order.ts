import { row, EVENT_ORDER, SERVED, eventOrderTest } from './section.ts';

export default row({
  order: 60,
  featureKeys: ['DataSnapshot'],
  api: 'Object.keys(snapshot.val())',
  behavior: 'Production and pyric order `val()` keys by priority, then key, on a ref and a query snapshot. RT-7, fixed in #1371.',
  evidence: '`oracle:rtdb-modular-remote-update-event-order` key `valKeys`, replayed in page and on the served planes; `packages/pyric/test/database/modular/snapshot-serialization.test.ts` adds priorities and nested values.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts key order'],
  oracleObservations: [EVENT_ORDER],
  conformanceTests: [
    eventOrderTest,
    `${SERVED}/rtdb-remote-update-event-order.test.ts`,
    'packages/pyric/test/database/modular/snapshot-serialization.test.ts',
  ],
});
