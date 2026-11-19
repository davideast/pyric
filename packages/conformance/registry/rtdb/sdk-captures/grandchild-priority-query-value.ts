import { row, CDD, SERVED } from './section.ts';

export default row({
  order: 90,
  featureKeys: ['onValue', 'setPriority'],
  api: "onValue(query) and a grandchild's priority change",
  behavior: "Production and pyric fire a value event on every reference and query listener above a grandchild whose priority changes, orderByKey queries included, across in-page and served planes. RP-8 (differential seed 7395).",
  evidence: '`oracle:rtdb-modular-grandchild-priority-query-value`, replayed in page and on the served SharedWorker and Node host planes.',
  risk: ['listener'],
  riskScore: 2,
  riskReasons: ['asserts listener semantics'],
  oracleObservations: ['rtdb-modular-grandchild-priority-query-value'],
  conformanceTests: [
    `${CDD}/capture-grandchild-priority-query-value.test.ts`,
    `${SERVED}/rtdb-grandchild-priority-query-value.test.ts`,
  ],
});
