import { row } from './section.ts';

export default row({
  order: 270,
  featureKeys: [],
  behavior: "`query.orderByKey` and `query.orderByPriority` read as production reads them, including for a read whose query does not set them",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r30-query-rules` records production reading `orderByKey` as true under `orderByKey()` and false for a plain read, and reading `orderByPriority` as true under `orderByPriority()` and false for a plain read. `oracle:rules-rtdb-r45-not-operator-runtime` (captured 2026-10-15) records `!query.orderByKey` ALLOWing, `!!query.orderByKey` DENYing, and `query.orderByKey == false` ALLOWing on a plain read (confirming `query.orderByKey` is boolean `false`, not `null`, and closing MET-1). `buildSimulatedQueryContext` and `querySpecToSimulationQuery` default `orderByKey`, `orderByValue`, and `orderByPriority` to `false` on reads and populate `orderByPriority: true` under `orderByPriority()`; the simulator matches all 20 `r30` verdicts and all 3 `r45` verdicts.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts query-gated read allow/deny behavior for orderByKey and orderByPriority"],
  oracleObservations: ["rules-rtdb-r30-query-rules", "rules-rtdb-r45-not-operator-runtime"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/pyric/test/rules/rtdb/simulation/handler.test.ts"],
  constructs: ["rtdb.binding.query.orderByKey", "rtdb.binding.query.orderByPriority"],
});
