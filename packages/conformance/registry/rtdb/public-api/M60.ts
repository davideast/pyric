import { row } from './section.ts';

export default row({
  order: 690,
  featureKeys: ["ref","query"],
  behavior: "`query(query(ref, c1), c2)` composes constraints — chaining folds both into one spec",
  status: "conforms",
  evidence: "`unit:modular/queries.test.ts` (\"query(query(ref, c1), c2) composes constraints\"); matches oracle `rtdb-modular-query-chaining-and-foreach-order.json` (local + SharedWorker + Node host replay)",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-chaining-and-foreach-order"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 60,
});
