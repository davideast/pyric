import { row, EVENT_ORDER, SERVED, eventOrderTest } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['setPriority', 'onChildChanged'],
  api: 'setPriority(ref) and child_changed',
  behavior: "Production and pyric fire `child_changed` on the parent's reference and query listeners for a priority-only change (`setPriority`) across in-page and served planes. RT-4.",
  evidence: '`oracle:rtdb-modular-remote-update-event-order` (`R changed a` and `Q changed a` after `setPriority`), replayed in page and on the served SharedWorker and Node host planes.',
  risk: ['listener'],
  riskScore: 2,
  riskReasons: ['asserts listener semantics'],
  oracleObservations: [EVENT_ORDER],
  conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
});
