import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "`matches()` is a **full-string** anchored RE2 test; `replace()`/`split()` take regexes (`replace` = all occurrences) (RULES-B4)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B4 block), `oracle:firestore-rules-cel-expressions-and-set-equality`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-cel-expressions-and-set-equality"],
  conformanceTests: [
    "packages/rules/test/simulator/evaluator.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
