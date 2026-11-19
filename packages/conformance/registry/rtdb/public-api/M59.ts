import { row } from './section.ts';

export default row({
  order: 680,
  featureKeys: ["onValue","query"],
  behavior: "`onValue(query)` initial fire delivers an empty window (`size === 0`) when the path is absent",
  status: "conforms",
  evidence: "`unit:modular/queries.test.ts` (\"initial fire on an empty path delivers an empty window\"); matches oracle `rtdb-modular-query-empty-and-oversized-window.json` (local + SharedWorker + Node host replay)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-empty-and-oversized-window"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 59,
});
