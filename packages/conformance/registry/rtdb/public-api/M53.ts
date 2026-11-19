import { row } from './section.ts';

export default row({
  order: 620,
  featureKeys: ["equalTo"],
  behavior: "`equalTo` with no matches returns an empty snapshot (`exists() === false`, `size === 0`)",
  status: "conforms",
  evidence: "`unit:modular/queries.test.ts` (\"returns an empty snapshot when nothing matches\"); matches oracle `rtdb-modular-query-empty-and-oversized-window.json` (local + SharedWorker + Node host replay)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-empty-and-oversized-window"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 53,
});
