import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "`mockData` becomes the value of `data` at every path during evaluation; `newData` is the proposed value for write/validate",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-data-newdata-and-snapshot-methods` records create-once and monotonic `data` vs `newData` transitions; replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host alongside `unit:simulation/handler.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-data-newdata-and-snapshot-methods"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
