import { row } from './section.ts';

export default row({
  order: 120,
  behavior: "A rule that raises a runtime error production also raises, such as a string method called on a number or on null, fails as that rule: a `.validate` denies the write and a `.read` or `.write` does not grant, and the result is a verdict, not an error. Only a construct the simulator does not evaluate, such as a method outside the rules language, surfaces as `EVALUATION_ERROR`",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-default-deny-and-runtime-errors`, `oracle:rules-rtdb-r17-validate-runtime-error`, and `oracle:rules-rtdb-r26-rule-runtime-error` record runtime type errors (`beginsWith` on number/null) failing closed as verdicts; replayed alongside `unit:simulation/handler.test.ts` and `unit:simulate-sandbox-agreement.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-default-deny-and-runtime-errors"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/rules/rtdb/simulate-sandbox-agreement.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
