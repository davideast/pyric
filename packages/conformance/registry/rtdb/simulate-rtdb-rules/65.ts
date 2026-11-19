import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "`data.child(\"...\")`, `data.parent()`, `data.exists()`, `data.val()` evaluate against the in-process snapshot - matches the documented `DataSnapshot` rule-context surface",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-data-newdata-and-snapshot-methods` records `data.exists()`, `data.val()`, `data.child(...)`, and `data.parent()` navigation; replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host alongside `unit:grammar/simulator.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-data-newdata-and-snapshot-methods"],
  conformanceTests: ["packages/rules/test/rtdb/grammar/simulator.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
