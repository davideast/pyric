import { row, EVENT_ORDER, SERVED, eventOrderTest } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['setPriority', 'onChildMoved'],
  api: 'child_moved on a query with no orderBy',
  behavior: 'Production and pyric fire `child_moved` for a priority change on a query with no `orderBy` (`L moved a`) across in-page and served planes. RT-5, part of #138.',
  evidence: '`oracle:rtdb-modular-remote-update-event-order`, replayed in page and on the served SharedWorker and Node host planes.',
  risk: ['listener'],
  riskScore: 2,
  riskReasons: ['asserts listener semantics'],
  oracleObservations: [EVENT_ORDER],
  conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
});
