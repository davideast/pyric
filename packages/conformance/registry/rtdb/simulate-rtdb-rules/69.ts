import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "When no node on the path carries a rule for the operation, the result is `{ allowed: false }` with empty `matchedPath` and `matchedRule` and a reason stating that no rule grants access: the request is denied by default",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-default-deny-and-runtime-errors` records default denial on ruleless branches; replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host alongside `unit:simulation/handler.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-default-deny-and-runtime-errors"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
