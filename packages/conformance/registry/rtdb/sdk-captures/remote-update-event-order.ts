import { row, EVENT_ORDER, SERVED, eventOrderTest } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['onValue', 'onChildAdded', 'onChildChanged', 'onChildRemoved', 'onChildMoved'],
  api: 'Event order for one remote multi-path update',
  behavior: 'Production and pyric fire deeper paths first and child events (`child_removed`, `child_added`, `child_moved`, `child_changed`) before `value` for one remote multi-path update across in-page and served planes. RT-2, RT-3.',
  evidence: '`oracle:rtdb-modular-remote-update-event-order` key `log`, replayed in page and on the served SharedWorker and Node host planes.',
  risk: ['listener', 'timing'],
  riskScore: 3,
  riskReasons: ['asserts listener semantics', 'asserts event ordering'],
  oracleObservations: [EVENT_ORDER],
  conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
});
