import { row } from './section.ts';

export default row({
  order: 1040,
  featureKeys: ["setPriority","onChildMoved","runTransaction"],
  behavior: "Priority changes participate in plain and explicitly ordered child movement/listener sequencing, transactions, and updates without losing metadata.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-priority-contract` captures priority movement, update/transaction preservation, and descendant delivery when ancestor replacement clears metadata; replayed by `unit:modular/priority-metadata-cdd.test.ts` and `unit:modular/priority-listeners.test.ts`. Disconnect priority execution is owned separately by M83.",
  risk: ["listener","atomicity","specific-field"],
  riskScore: 5,
  riskReasons: ["asserts listener semantics","asserts transaction/batch atomicity","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-priority-contract"],
  conformanceTests: ["packages/pyric/test/database/modular/priority-metadata-cdd.test.ts","packages/pyric/test/database/modular/priority-listeners.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M91",
    observation: "rtdb-modular-priority-contract",
    expect: { moved: [["a",null]], plainMoved: [["a",null]], samePositionMoved: [["c","b"]], samePositionPlainMoved: [["c","b"]], allMoved: [["a",null],["c","b"],["b",null],["c","b"]], allPlainMoved: [["a",null],["c","b"],["b",null],["c","b"]], orderedValueDeliveriesAfterMove: 2, orderedValueDeliveriesAfterSamePositionChange: 3, totalOrderedValueDeliveries: 7, afterUpdate: 0, afterTransaction: 0, descendantPriorityDeliveries: [{ value: 1, priority: 9 },{ value: 1, priority: null },{ value: 2, priority: null }], afterAncestorReplacementCount: 2, afterAncestorPriorityOnlyCount: 2 },
    probe: "packages/pyric/test/database/modular/priority-listeners.test.ts",
    guards: "Priority movement, metadata preservation, and descendant value-listener delivery after ancestor replacement stay pinned to production.",
  }],
  rowNumber: 91,
});
