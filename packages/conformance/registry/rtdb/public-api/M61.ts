import { row } from './section.ts';

export default row({
  order: 700,
  featureKeys: ["query"],
  behavior: "Snapshot from a query exposes children via `snap.forEach` in the executor-computed order — NOT necessarily the order `Object.entries(val)` would yield",
  status: "conforms",
  evidence: "`unit:modular/queries.test.ts` (\"forEach visits children in ascending order of the child key\"); matches oracle `rtdb-modular-query-chaining-and-foreach-order.json` (local + SharedWorker + Node host replay)",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-chaining-and-foreach-order"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 61,
});
