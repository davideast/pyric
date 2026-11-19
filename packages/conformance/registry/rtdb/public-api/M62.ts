import { row } from './section.ts';

export default row({
  order: 710,
  featureKeys: ["startAt"],
  behavior: "`startAt(value, key)` uses `key` as the tie-breaker when multiple children share the same ordered value — children before `key` are dropped, the row at `key` is included (inclusive cursor)",
  status: "conforms",
  evidence: "`unit:modular/queries.test.ts` (\"startAt with key tie-breaker drops earlier same-value children\"); matches oracle `rtdb-modular-startat-key-tiebreaker-and-missing-child.json` (local + SharedWorker + Node host replay)",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-startat-key-tiebreaker-and-missing-child"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 62,
});
