import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "When no `.read`/`.write` rule on the path allows, the result is `{ allowed: false }` with `matchedPath` and `matchedRule` naming the deepest node that carries a rule of the operation's kind, which is an ancestor when the deepest rules node on the path has only children, only a `.validate`, or only the other operation's rule",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-default-deny-and-runtime-errors` and `oracle:rules-rtdb-r24-deny-without-rule` record ancestor deny verdicts when descendants carry only `.validate` or the opposite operation; replayed alongside `unit:simulation/handler.test.ts` and `unit:simulate-sandbox-agreement.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-default-deny-and-runtime-errors"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/rules/rtdb/simulate-sandbox-agreement.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
