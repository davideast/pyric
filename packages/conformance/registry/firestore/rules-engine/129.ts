import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Cross-doc `get(/databases/$(database)/documents/...)` in rules works under sandbox; `get()` of a **missing** doc ERRORS (guard with `exists()`), and `get(p).id` / `get(p).__name__` expose the doc identity (RULES-B8)",
  status: "conforms",
  evidence: "`playground:rules-cross-doc-get`, `unit:rules/simulator/evaluator.test.ts` (RULES-B8 block), `oracle:firestore-rules-write-and-cross-doc-verdicts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-write-and-cross-doc-verdicts"],
  conformanceTests: [
    "packages/rules/test/simulator/evaluator.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
