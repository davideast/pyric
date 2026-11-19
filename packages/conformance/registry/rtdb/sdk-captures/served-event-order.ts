import { row, EVENT_ORDER, SERVED, eventOrderTest } from './section.ts';

export default row({
  order: 70,
  featureKeys: ['onValue', 'onChildChanged'],
  api: 'Event order for one remote update on the served planes',
  behavior: "Production and the served SharedWorker and Node host planes deliver one write's events deepest path first, child events before value. RP-5.",
  evidence: '`oracle:rtdb-modular-remote-update-event-order`, replayed on the served SharedWorker and Node host planes and in page.',
  risk: ['listener', 'timing'],
  riskScore: 3,
  riskReasons: ['asserts listener semantics', 'asserts event ordering'],
  oracleObservations: [EVENT_ORDER],
  conformanceTests: [`${SERVED}/rtdb-remote-update-event-order.test.ts`, eventOrderTest],
});
