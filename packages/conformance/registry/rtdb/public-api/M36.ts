import { row } from './section.ts';

export default row({
  order: 450,
  featureKeys: ["ref","query"],
  behavior: "`query(ref, ...constraints)` + ordering/range constraints",
  status: "conforms",
  evidence: "`unit:upstream-rtdb-probes.test.ts` (\"orderByChild('a/b') + limitToFirst orders by the nested path\") + `unit:modular/queries.test.ts` + oracle observation `rtdb-modular-query-chaining-and-foreach-order.json` (local + SharedWorker + Node host replay); see M49-M64 for the per-claim breakdown.",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-chaining-and-foreach-order"],
  conformanceTests: ["packages/pyric/test/database/upstream-rtdb-probes.test.ts","packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 36,
});
