import { row } from './section.ts';

export default row({
  order: 380,
  featureKeys: ["ref","onChildMoved","setPriority"],
  behavior: "A plain-reference `onChildMoved` uses Firebase's default priority index: ordinary value changes that preserve priority do not move, while each changed child's priority emits one event even if its predecessor stays the same",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-priority-contract` captures the same one-event-per-priority-operation sequence on a plain ref and an explicit `orderByPriority()` query, including a priority change that retains the same predecessor; `unit:modular/sandbox-child-events.test.ts` separately pins no movement for an ordinary value-only change. `unit:modular/priority-listeners.test.ts` pins a move for each child whose own priority one parent write changes, and none for a change to a descendant's priority alone.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-priority-contract"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts","packages/pyric/test/database/modular/priority-metadata-cdd.test.ts","packages/pyric/test/database/modular/priority-listeners.test.ts"],
  rowNumber: 46,
});
